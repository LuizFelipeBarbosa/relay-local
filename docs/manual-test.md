# Test Relay manually on this Mac

This test sends your own requests through the full path:

`curl → coordinator → Relay agent → Ollama/Gemma → streamed answer`

The binaries and Gemma model are already installed. Open four Terminal tabs.
The example credentials below are for this loopback-only test; use independently
generated credentials when connecting to a cloud server.

## Terminal 1: start Ollama

Skip this command if Ollama is already running.

```sh
OLLAMA_HOST=127.0.0.1:11434 /opt/homebrew/bin/ollama serve
```

Leave the process running. An "address already in use" message means something
is already listening there; check `curl http://127.0.0.1:11434/api/version` in
another tab to confirm it is Ollama. Do not stop an existing service just to
start another copy.

## Terminal 2: start the coordinator

```sh
export RELAY_MAC_TOKEN=local-host-test
export RELAY_BUYER_TOKEN=local-buyer-test

/Users/luiz/Developer/relay/dist/relay-coordinator \
  --config /Users/luiz/Developer/relay/examples/local-coordinator.json
```

Expect `reference coordinator listening` at `127.0.0.1:8080`. Keep it running.

## Terminal 3: check and start the agent

```sh
export RELAY_MAC_TOKEN=local-host-test

/Users/luiz/Developer/relay/dist/relay doctor \
  --config /Users/luiz/Developer/relay/examples/local-agent.json

/Users/luiz/Developer/relay/dist/relay run \
  --config /Users/luiz/Developer/relay/examples/local-agent.json
```

The diagnostic should report `ollama: ready=true`, model `ollama/gemma4:e2b`, and
`Coordinator: authenticated WebSocket reachable`. The running agent should then
report `host connected`; the coordinator should report `host registered`.

The exported host token must have the same value in terminals 2 and 3. Environment
variables exported in one terminal are not automatically available in other tabs.

## Terminal 4: discover models and request a response

```sh
curl -sS http://127.0.0.1:8080/v1/models \
  -H 'Authorization: Bearer local-buyer-test'
```

Expect a model list containing `ollama/gemma4:e2b`. Send a streaming request:

```sh
curl -sS -N http://127.0.0.1:8080/v1/chat/completions \
  -H 'Authorization: Bearer local-buyer-test' \
  -H 'Content-Type: application/json' \
  -d '{"model":"ollama/gemma4:e2b","stream":true,"max_tokens":128,"messages":[{"role":"user","content":"Explain what a rainbow is in two sentences."}]}'
```

You should see `data:` lines containing generated text in `choices[].delta.content`,
followed by `data: [DONE]`. The first request can take longer while the model loads.
The agent and coordinator log the attempt IDs and completion status.

For a complete JSON response instead, change `"stream":true` to `"stream":false`
and run the same command. The answer is under `choices[0].message.content`.

## Verify failure handling

- **Unavailable host:** press Ctrl+C in terminal 3, then repeat the request in
  terminal 4. Expect `no_capacity` with HTTP 503. Restart the agent using the same
  command and repeat the request; responses should resume.
- **Incorrect buyer key:** replace `local-buyer-test` with `wrong-key`. Expect an
  `unauthorized` error with HTTP 401. Add `-i` to curl to see HTTP status headers.
- **Cancellation:** request a long answer with a larger `max_tokens`, then press
  Ctrl+C in terminal 4 while it is streaming. The agent should log cancellation
  and accept the next request. A request that already finished may log completion.

## Test Codex and Claude Code streaming through CLIProxyAPI

Keep the coordinator running. CLIProxyAPI must also be running on
`127.0.0.1:8317` with a working provider login. Its client API key is the key in
the local CLIProxyAPI `api-keys` configuration, not its management password.

Stop the agent in terminal 3 with Ctrl+C. In that same terminal, enter the client
key using this zsh prompt, which does not echo the key or put it in shell history:

```sh
export RELAY_MAC_TOKEN=local-host-test
read -rs 'CLIPROXYAPI_KEY?CLIProxyAPI client API key: '
printf '\n'
export CLIPROXYAPI_KEY

/Users/luiz/Developer/relay/dist/relay doctor \
  --config /Users/luiz/Developer/relay/examples/local-cliproxy-agent.json

/Users/luiz/Developer/relay/dist/relay run \
  --config /Users/luiz/Developer/relay/examples/local-cliproxy-agent.json
```

This configuration shares `cliproxyapi/gpt-5.6-sol` and
`cliproxyapi/claude-sonnet-4-6`, both advertised by this Mac's CLIProxyAPI service
when checked. Ollama is not required for this configuration. Model discovery
does not guarantee the upstream account has remaining quota.

In terminal 4, test Codex:

```sh
curl -sS -N http://127.0.0.1:8080/v1/chat/completions \
  -H 'Authorization: Bearer local-buyer-test' \
  -H 'Content-Type: application/json' \
  -d '{"model":"cliproxyapi/gpt-5.6-sol","stream":true,"max_tokens":256,"messages":[{"role":"user","content":"Count from 1 to 10, one number per line."}]}'
```

Then test Claude Code's provider:

```sh
curl -sS -N http://127.0.0.1:8080/v1/chat/completions \
  -H 'Authorization: Bearer local-buyer-test' \
  -H 'Content-Type: application/json' \
  -d '{"model":"cliproxyapi/claude-sonnet-4-6","stream":true,"max_tokens":256,"messages":[{"role":"user","content":"Count from 1 to 10, one number per line."}]}'
```

`-N` disables curl's output buffering. Each successful request should produce
`data:` events with generated content followed by `data: [DONE]`. Run these
sequentially because this example permits one active request. Provider rate limits
can return HTTP 429; `no_capacity` means Relay has no eligible free host.

For a direct CLIProxyAPI check, send the same Chat Completions request to port
8317, use `Authorization: Bearer $CLIPROXYAPI_KEY`, and remove the `cliproxyapi/`
model prefix. Set that environment variable in the terminal running curl as well.
These are inference API tests; they do not launch interactive Codex or Claude Code
CLI sessions or execute their tools.

### If Claude or Codex requests are not working

First inspect the models actually registered with Relay:

```sh
curl -sS http://127.0.0.1:8080/v1/models \
  -H 'Authorization: Bearer local-buyer-test'
```

If the list contains only `ollama/gemma4:e2b`, the running agent still uses the
Ollama-only configuration. Stop that agent and restart it with
`examples/local-cliproxy-agent.json` using the instructions above. To expose
Gemma, Codex, and Claude together, use `examples/agent.json` instead; Ollama and
CLIProxyAPI must both be running, and `CLIPROXYAPI_KEY` must be exported in that
terminal. Only run one agent with host ID `my-mac` at a time. Editing a config file
does not change the running agent until it restarts.

A 401 from CLIProxyAPI without an Authorization header is expected: its client
API key protects the local HTTP endpoint. This is separate from the provider
logins used to generate responses. A model appearing in CLIProxyAPI's catalog
does not by itself prove that its provider login works; test a request directly
as described above.

If a direct request reports a missing or invalid provider login, the installed
CLIProxyAPI supports these sign-in commands. Run the command for the affected
provider and complete its browser sign-in:

```sh
/opt/homebrew/bin/cliproxyapi -config /opt/homebrew/etc/cliproxyapi.conf -codex-login
/opt/homebrew/bin/cliproxyapi -config /opt/homebrew/etc/cliproxyapi.conf -claude-login
```

An HTTP 429 indicates rate limiting or quota; it is not evidence that a new login
is needed. A successful direct request followed by Relay `no_capacity` points to
the Relay agent's registration, allowlist, or occupied request slots.

## Stop the test

Press Ctrl+C in each terminal running a process you started. Leave any preexisting
Ollama or CLIProxyAPI service running if you still use it. This test creates no
public endpoint and makes no router changes. For the partner server, follow
the cloud connection requirements in `docs/cloud-readiness.md`.
