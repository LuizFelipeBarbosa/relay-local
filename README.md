# Relay

Relay connects local Ollama and CLIProxyAPI services to a coordinator through an
**outbound WebSocket**. Hosts never accept network connections. The coordinator
exposes `/v1/models` and `/v1/chat/completions` to buyers and streams responses back
without collecting complete answers.

This repository includes a Go host agent, a reference coordinator, a deterministic
fake backend, and a language-neutral protocol for a separately implemented server.
The coordinator is intended for private integration testing; it uses in-memory
state and has no accounts, payments, persistent queue, or ledger.

## Local command center

`relay install --mode gui` creates a per-user Relay configuration, writes a
launchd (macOS) or systemd user service, and opens the local command center.
`relay install --mode headless` performs the same setup and prints the command to
start the service. Run `relay serve --config <path>` when a user service manager
is unavailable, then use `relay dashboard --config <path>` to open the browser.

The dashboard is bound to `127.0.0.1:7331` and authenticates with a generated
owner-only token. It discovers the complete inventory exposed by configured local
Ollama and CLIProxyAPI endpoints, while only allowlisted models are advertised to
the coordinator. The Models page can enable or disable offers independently of
what is installed. Ollama pull and delete jobs are exposed through the dashboard;
provider sign-in remains in CLIProxyAPI's own supported browser or terminal flow.

Runtime release artifacts are selected through the checked-in installer manifest
and are rejected unless their SHA-256 matches the pinned entry. A release must
populate that manifest for its supported macOS/Linux architectures before the
installer can download a runtime. Existing runtime binaries and services are
detected and can be used without downloading anything.

## Quick start

For an interactive test with your installed Gemma model, follow
[the four-terminal manual test](docs/manual-test.md).

Install Go 1.25+ and Python 3, then run:

```sh
make test vet smoke
```

`make smoke` compiles all three commands and starts a temporary coordinator, two
agents, and a fake backend. It checks streaming, non-streaming, and log privacy,
then stops its processes. No runtime credentials or model downloads are required.

```sh
make build
./dist/relay init --host-id my-mac \
  --ollama-model gemma4:e2b --cliproxyapi-model claude-sonnet-4-6
```

Initialization creates a private `relay.json` and refuses to overwrite an existing
file. Edit the exact allowlists to match models installed in your runtimes. Empty
allowlists share nothing. Remove a backend entry if that service is not in use.
Backend URLs are roots, e.g. `http://127.0.0.1:8317`, without a `/v1` suffix.

## Connect real runtimes

Start Ollama separately and install your chosen model using Ollama. Sign in to
your chosen provider through CLIProxyAPI and start its local service. Relay never
starts, stops, upgrades, reconfigures, or authenticates these runtime processes.

- Ollama defaults to `http://127.0.0.1:11434`. Only allowlisted local models with a
  digest are advertised; Ollama remote/cloud entries are excluded.
- CLIProxyAPI defaults to `http://127.0.0.1:8317`. Set `CLIPROXYAPI_KEY` to its
  **client API key**, not its management key or the provider's OAuth credential.
  Bind CLIProxyAPI to `127.0.0.1`; its upstream default may bind all interfaces.
- The backend IDs become model prefixes: `ollama/gemma4:e2b` and
  `cliproxyapi/claude-sonnet-4-6`. The agent strips its own prefix by substituting
  the discovered native model name, preserving other request fields.

The runtime interfaces are documented by [Ollama](https://docs.ollama.com/api/openai-compatibility)
and [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). CLIProxyAPI's own
provider retries and account selection remain controlled by its configuration;
Relay does not promise exactly-once upstream execution or verified usage counts.

Generate a separate random token for each host and the buyer, for example with
`python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`. Set the credentials
through environment variables or your process manager; do not put them in JSON.

Copy `examples/coordinator.json` to `coordinator.json`, edit the host mapping,
and set the environment variables it references. In separate terminals:

```sh
./dist/relay-coordinator --config coordinator.json
./dist/relay doctor --config relay.json
./dist/relay run --config relay.json
```

The agent's `host_id` must match the coordinator's mapping, and the credential
values must match even if their environment-variable names differ. The example
coordinator expects tokens for both `my-mac` and `my-linux`; remove unused hosts.
`doctor` reports allowlisted models and backend readiness, and authenticates a
WebSocket upgrade without registering capacity or disrupting an existing agent.
Missing runtime credentials make that backend unavailable; another healthy
backend can still serve requests. A missing host credential prevents agent startup.

```sh
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $RELAY_BUYER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"ollama/gemma4:e2b","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

Real-backend checks use already-running services:

```sh
python3 scripts/smoke.py \
  --ollama-model gemma4:e2b \
  --cliproxyapi-model claude-sonnet-4-6 \
  --report dist/real-smoke.json
```

This requires `CLIPROXYAPI_KEY`. Both streaming modes generate a short answer on
each selected backend. The check does not download models or start the runtimes.

## Operation and limits

- Only the coordinator accepts external connections. Outside loopback, configure
  its `tls_cert` and `tls_key`, listen on the desired interface, and point agents
  at `wss://your-coordinator/relay/v1/connect`. Configure TLS directly on the
  reference coordinator; no forwarded-header trust or TLS-terminating-proxy mode
  is provided. Hosts require outbound TCP access only, normally to port 443.
- Backends must resolve exclusively to loopback. Each dial uses a validated IP;
  environment HTTP proxies and redirects are disabled for backend calls.
- Allowlists are exact and case-sensitive. Configuration reload requires an agent
  restart; model availability is refreshed every 30 seconds.
- Concurrency defaults to one per backend, with at most 64 active attempts per
  agent. A model listing reports capability, not guaranteed idle capacity.
- Heartbeats run every five seconds; silence for ten seconds drops the session.
  Active HTTP calls are cancelled, and reconnects advertise fresh state.
- Response-start and total timeouts default to 120 and 600 seconds. Request
  bodies are limited to 1 MiB; response chunks to 32 KiB; queued response data to
  256 KiB per attempt. Slow consumers are cancelled rather than buffering forever.
- One retry on another host is permitted before the first buyer response byte.
  After that, an interrupted SSE stream ends with a Relay error, without a
  fabricated `[DONE]`. Partial non-streaming JSON aborts the HTTP response.
- Tools are passed through as inference data. Relay never executes requested
  tools, shell commands, or CLI agent jobs on a host.
- Logs contain IDs, timings, bytes, errors, and numeric backend-reported usage.
  They omit prompts, completions, keys, and backend error bodies. Runtime logs
  are controlled by the runtime operators, separately from Relay.

Inference payloads necessarily reach the host and its chosen backend. Initial
deployment assumes trusted private hosts. Source labels and model digests are
claims, not attestation; CLIProxyAPI-backed entries are marked `provider` because
Relay does not inspect their underlying routing configuration.

## Partner handoff and releases

Read [the wire contract](docs/protocol.md), [JSON Schema](protocol/schema.json),
[example exchanges](docs/protocol-examples.json), and
[integration/acceptance guide](docs/integration.md).

```sh
make release
```

This produces archives and SHA-256 checksums in `dist/` for macOS and Linux on
ARM64 and AMD64. Binaries are built without CGO; archives are unsigned. In a binary
archive, commands are at its root instead of under `dist/`. Automated CI runs
tests on macOS and Linux, checks schema fixtures, and builds all four archives.

Implementation layout: `cmd/` contains the three executables, `internal/` contains
the adapters, agent, transport and reference coordinator, and `protocol/` contains
the Go wire types and public schema. No Go SDK dependency on CLIProxyAPI is needed.
# relay-local
