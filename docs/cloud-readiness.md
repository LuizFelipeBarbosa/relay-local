# Local test and cloud integration readiness

**Result: the local inference path is ready for a private cloud integration test.**
Actual connectivity to the partner's cloud server remains untested because that
server is not available yet. These checks do not certify a production service.

Tested on the user's Mac on September 12, 2026, using the compiled Relay agent
and reference coordinator with installed Ollama and CLIProxyAPI services.

## Real generated responses

The buyer submitted a fixed synthetic prompt asking for the word hello through
`POST /v1/chat/completions`. Both regular JSON and SSE were checked for nonempty
assistant text. Stream events were parsed, and the completion marker was required.

| Backend | Mode | HTTP | Actual answer | First response byte |
|---|---|---|---|---|
| Gemma `gemma4:e2b` through Ollama | JSON | 200 | `hello` | 6.775 s |
| Gemma `gemma4:e2b` through Ollama | SSE | 200 | `hello` | 0.455 s |
| Claude `claude-sonnet-4-6` through CLIProxyAPI | JSON | 200 | `Hello.` | 2.709 s |
| Claude `claude-sonnet-4-6` through CLIProxyAPI | SSE | 200 | `Hello.` | 3.118 s |

The latest Claude requests passed with the existing configured credentials.
Earlier provider rate limits did not recur in this run. No account or provider
configuration was changed. Ollama was started temporarily for testing and stopped
afterward; the preexisting CLIProxyAPI service was left running.

## Connection and failure checks

- TLS/WebSocket registration succeeded with valid host authentication and a
  correctly trusted certificate.
- The same connection survived 31 seconds, crossing several heartbeats and the
  reference server's 30-second HTTP read timeout, then successfully streamed an
  inference response. This did not rely on silent reconnection.
- Untrusted certificates and wrong certificate hostnames were rejected before an
  HTTP response; those tests supplied valid host credentials so a later 401 could
  not disguise a failed certificate check.
- Missing host credentials were rejected even over valid TLS.
- Both compiled agent processes had zero listening TCP sockets, inspected with
  `lsof` during the fake-backend smoke test.
- Race-enabled tests covered cancellation, timeouts, reconnects, capacity limits,
  slow consumers, malformed frames, duplicate attempts, allowlists and retry
  boundaries. JSON Schema conformance and `go vet` passed.
- The smoke test checked logs for credential and synthetic-prompt leakage.

TLS tests use the production agent and coordinator code with a fixture certificate
trusted only inside the test process. Certificate verification stays enabled, and
the Mac's trust store is not modified. The real-backend binary smoke tests use
loopback HTTP; neither setup substitutes for a real WAN/cloud test.

## What the partner's server needs

1. A reachable `wss://<coordinator>/relay/v1/connect` endpoint with a certificate
   trusted by the host, implementing [the v1 wire protocol](protocol.md).
2. A host identity and bearer credential configured at both ends.
3. Request dispatch and response-chunk handling compatible with the supplied
   schema, including cancellation, heartbeats and retry boundaries.

Once that exists, configure the agent's `coordinator_url`, `host_id`, and
`token_env`, then run `relay doctor` and `relay run`. Repeat the real-response tests
through the cloud gateway, followed by [the separate-network procedure](integration.md).
The host requires only outbound access; the cloud coordinator accepts inbound
connections. No cloud deployment, DNS change, router change or public endpoint
was created during these local checks.

Evidence: `dist/local-real-smoke.json`, `dist/local-fake-smoke.json`,
`dist/cloud-readiness-test-run.log`, and `dist/tls-test-run.log`.
