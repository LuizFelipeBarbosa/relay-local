# Partner integration and acceptance

## Implementing the production server

1. Authenticate the host's outbound WebSocket and implement `hello`/`welcome`
   against `protocol/schema.json`. The host credential determines its identity.
2. Maintain connection-scoped catalogs, liveness timers, and attempt reservations.
   Make host selection/reservation atomic. Do not double-count `available` and
   your outstanding reservations.
3. Forward Chat Completions JSON using the documented request envelope. Retain
   the complete request only until completion/deadline, for the single safe retry.
4. Use an independent, bounded response queue for each attempt. Decode base64,
   enforce sequence numbers, write bytes, and flush buyer streams promptly.
5. Propagate cancellation, require terminal acknowledgement before reusing slots,
   and fail affected attempts when a socket disappears. Do not replay after
   reconnect or after buyer response commitment.
6. Treat all host metadata and usage as unverified. Store only approved operational
   data in your own logs/ledger. Keep buyer and host credentials separate.

The Go reference coordinator supplies a runnable implementation, not a required
production dependency. `internal/coordinator/integration_test.go` covers the
complete agent/gateway path and can serve as a behavioral reference for other
languages. `docs/protocol-examples.json` can seed a conformance suite.

## Local verification

```sh
make test vet smoke
python3 -m venv .tools/schema-venv
.tools/schema-venv/bin/pip install jsonschema==4.25.1
.tools/schema-venv/bin/python scripts/check-schema.py
make release
```

The race-enabled tests cover both backend adapters, fragmented Unicode/SSE,
tool fields, usage, discovery allowlists, remote Ollama exclusion, credentials,
redirect/DNS boundaries, capacity, cancellation, response-start timeouts,
duplicates, heartbeat loss, reconnects, retry digest constraints, and bounded
slow consumers. Binaries are cross-compiled for all four platform/architecture
combinations. CI runs native tests on macOS and Linux; cross-compilation alone
does not prove a binary was exercised on each CPU architecture.

Use `scripts/smoke.py --ollama-model ... --cliproxyapi-model ...` for real local
backends. It starts temporary Relay processes only, uses environment credentials,
and cleans up on exit. Its two local agents demonstrate multiplexed connectivity
and routing; **they do not constitute a separate-network NAT test**.

## Separate-network acceptance procedure

This step requires a reachable coordinator and two machines on different networks.
Only the coordinator needs an externally reachable listening port. Do not configure
host router forwarding, UPnP, reverse SSH listeners, or inbound firewall exceptions.

1. Run the reference coordinator with a valid TLS certificate, its matching key,
   and `listen: "0.0.0.0:443"` (or another permitted TLS port). Its host map must
   contain two distinct IDs and credential environment variables. Provision
   credentials privately on each machine.
2. Install the release binary and runtime prerequisites on host A, connected to
   one network, and host B, connected to a different network such as a hotspot.
   Set the same WSS coordinator URL, distinct host IDs, and identical backend IDs.
3. For local failover tests, install the same model digest on both hosts. Confirm
   both agents register in coordinator logs. Record OS/architecture and runtime
   versions without recording keys or prompts.
4. Send four sequential requests to the public gateway for that model, including
   streaming and non-streaming. Match gateway request/attempt IDs to both host IDs
   in the coordinator logs; verify both hosts actually served requests.
5. Disconnect one host before its response starts. Confirm one safe retry to the
   other host with the same digest, or a documented failure if no capacity exists.
6. Disconnect a host after observing streamed content. Confirm interruption rather
   than a replacement answer. Reconnect it and verify a new request succeeds.
7. Cancel a buyer request and verify its agent releases capacity. Confirm neither
   host has a Relay listener and no router changes were made.

Record the date, coordinator address, host/network identities, versions, matched
request IDs, retry/interruption outcomes, and confirmation that host ingress stayed
closed. Never claim this acceptance step passed based on local processes alone.

## Deferred work

Runtime installation/supervision, model downloads, automatic GPU tuning, Responses
and Anthropic APIs, Windows, persistence, accounts, payments, public signup,
attestation/reputation and dashboards remain outside this private integration MVP.
Public deployment needs a separately designed production coordinator; no database
or third-party service is required to develop the agent and wire contract.
