#!/usr/bin/env python3
"""Exercise compiled binaries. Real mode attaches to existing runtime services."""
import argparse
import datetime
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def request(url, key, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    return urllib.request.urlopen(req, timeout=180)


def answer_text(received, stream):
    """Require actual assistant text, including correctly framed SSE deltas."""
    if not stream:
        response = json.loads(received)
        assert isinstance(response.get('choices'), list), 'missing completion choices'
        return ''.join(choice.get('message', {}).get('content') or ''
                       for choice in response['choices'])
    text = []
    done = False
    for event in received.decode('utf-8').replace('\r\n', '\n').split('\n\n'):
        data = '\n'.join(line[5:].lstrip(' ') for line in event.splitlines()
                         if line.startswith('data:'))
        if not data:
            continue
        if data == '[DONE]':
            done = True
            continue
        chunk = json.loads(data)
        assert 'error' not in chunk, 'backend or relay returned a stream error'
        for choice in chunk.get('choices', []):
            text.append(choice.get('delta', {}).get('content') or '')
    assert done, 'stream missing completion marker'
    return ''.join(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', default='dist')
    parser.add_argument('--ollama-model')
    parser.add_argument('--ollama-url', default='http://127.0.0.1:11434')
    parser.add_argument('--cliproxyapi-model')
    parser.add_argument('--cliproxyapi-url', default='http://127.0.0.1:8317')
    parser.add_argument('--report')
    args = parser.parse_args()
    binaries = Path(args.bin_dir).resolve()
    real = bool(args.ollama_model or args.cliproxyapi_model)
    if args.cliproxyapi_model and not os.environ.get('CLIPROXYAPI_KEY'):
        parser.error('set CLIPROXYAPI_KEY in the environment for real CLIProxyAPI checks')
    env = os.environ.copy()
    for key in ('SMOKE_HOST_A', 'SMOKE_HOST_B', 'SMOKE_BUYER'):
        env[key] = secrets.token_urlsafe(32)
    port = free_port()
    gateway = f'http://127.0.0.1:{port}'
    results = []
    processes = []
    agent_processes = []
    socket_checks = []
    with tempfile.TemporaryDirectory(prefix='relay-smoke-') as tmp:
        root = Path(tmp)

        def start(command, *arguments):
            log = (root / f'{command}-{len(processes)}.log').open('w')
            proc = subprocess.Popen([str(binaries / command), *arguments], env=env,
                                    stdout=log, stderr=log)
            processes.append((proc, log))
            if command == 'relay':
                agent_processes.append(proc)

        try:
            backends = []
            if not real:
                fake_port = free_port()
                start('relay-fake-backend', '--listen', f'127.0.0.1:{fake_port}')
                backends.append(dict(id='ollama', kind='ollama',
                                     url=f'http://127.0.0.1:{fake_port}', models=['fake'], concurrency=1))
            if args.ollama_model:
                backends.append(dict(id='ollama', kind='ollama', url=args.ollama_url,
                                     models=[args.ollama_model], concurrency=1))
            if args.cliproxyapi_model:
                backends.append(dict(id='cliproxyapi', kind='cliproxyapi', url=args.cliproxyapi_url,
                                     key_env='CLIPROXYAPI_KEY', models=[args.cliproxyapi_model], concurrency=1))
            coordinator = root / 'coordinator.json'
            coordinator.write_text(json.dumps(dict(listen=f'127.0.0.1:{port}', buyer_token_env='SMOKE_BUYER',
                hosts={'host-a': 'SMOKE_HOST_A', 'host-b': 'SMOKE_HOST_B'})))
            start('relay-coordinator', '--config', str(coordinator))
            # Two separately running agents; this is not a separate-network/NAT test.
            for host, token in [('host-a', 'SMOKE_HOST_A'), ('host-b', 'SMOKE_HOST_B')]:
                path = root / f'{host}.json'
                path.write_text(json.dumps(dict(coordinator_url=f'ws://127.0.0.1:{port}/relay/v1/connect',
                    host_id=host, token_env=token, backends=backends)))
                start('relay', 'run', '--config', str(path))
            expected = {f"{b['id']}/{m}" for b in backends for m in b['models']}
            deadline = time.monotonic() + 45
            available = set()
            while time.monotonic() < deadline:
                if any(proc.poll() is not None for proc, _ in processes):
                    raise RuntimeError('a smoke-test process exited unexpectedly')
                try:
                    with request(gateway + '/v1/models', env['SMOKE_BUYER']) as response:
                        available = {m['id'] for m in json.load(response)['data']}
                    if expected <= available:
                        break
                except (urllib.error.URLError, TimeoutError):
                    pass
                time.sleep(0.1)
            if not expected <= available:
                raise RuntimeError('configured model(s) not advertised; check services, credentials and allowlists')
            lsof = shutil.which('lsof')
            if lsof:
                for proc in agent_processes:
                    sockets = subprocess.run([lsof, '-nP', '-a', '-p', str(proc.pid),
                                              '-iTCP', '-sTCP:LISTEN', '-Fn'],
                                             text=True, capture_output=True, timeout=10)
                    listeners = [line[1:] for line in sockets.stdout.splitlines() if line.startswith('n')]
                    assert proc.poll() is None, 'agent exited during socket check'
                    assert sockets.returncode in (0, 1) and not sockets.stderr, 'socket inspection failed'
                    assert not listeners, 'agent unexpectedly opened a listening port'
                    socket_checks.append(dict(pid=proc.pid, listening_sockets=listeners, outcome='passed'))
                print('PASS agents have no listening TCP sockets', flush=True)
            for model in sorted(expected):
                for stream in (False, True):
                    started = time.monotonic()
                    body = dict(model=model, stream=stream, max_tokens=64,
                                messages=[dict(role='user', content='Reply with the word hello.')])
                    if stream:
                        body['stream_options'] = {'include_usage': True}
                    try:
                        with request(gateway + '/v1/chat/completions', env['SMOKE_BUYER'], body) as response:
                            received = response.read(1)
                            first_byte = time.monotonic() - started
                            received += response.read()
                            text = answer_text(received, stream)
                            assert text.strip(), 'empty assistant response'
                            results.append(dict(model=model, stream=stream, outcome='passed', status=response.status,
                                bytes=len(received), first_byte_seconds=round(first_byte, 3),
                                response_preview=text[:160],
                                total_seconds=round(time.monotonic() - started, 3)))
                        print(f'PASS {model} stream={stream}', flush=True)
                    except (urllib.error.URLError, TimeoutError, AssertionError, ValueError) as error:
                        status = error.code if isinstance(error, urllib.error.HTTPError) else None
                        results.append(dict(model=model, stream=stream, outcome='failed',
                                            status=status, error=type(error).__name__))
                        print(f'FAIL {model} stream={stream} status={status} error={type(error).__name__}', flush=True)
            for _, log in processes:
                log.flush()
            combined = ''.join(p.read_text() for p in root.glob('*.log'))
            for key in ('SMOKE_HOST_A', 'SMOKE_HOST_B', 'SMOKE_BUYER', 'CLIPROXYAPI_KEY'):
                if env.get(key):
                    assert env[key] not in combined, 'credential appeared in logs'
            assert 'Reply with the word hello.' not in combined, 'prompt appeared in logs'
        finally:
            for proc, log in reversed(processes):
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                log.close()
    report = dict(timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  mode='real' if real else 'fake', checks=results,
                  agent_socket_checks=socket_checks,
                  separate_network_test='not run; requires a second physical network')
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return int(any(check['outcome'] != 'passed' for check in results))


if __name__ == '__main__':
    raise SystemExit(main())
