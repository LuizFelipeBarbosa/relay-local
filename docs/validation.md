# Validation record

Retested locally on September 12, 2026, on macOS ARM64 (Apple M1 Max).
Build toolchain: Go 1.27.1. The module requires Go 1.25 or newer.

The latest checks confirm actual assistant text, rather than only HTTP success.
See [the cloud readiness report](cloud-readiness.md) for the current handoff status.

| Check | Result |
|---|---|
| `go test -race -count=1 -timeout 90s ./...` | Passed; agent, adapters, configuration, gateway integration, TLS and protocol fixtures |
| `go vet ./...` | Passed |
| Draft 2020-12 JSON Schema | 11 valid and 6 invalid fixtures behaved as expected |
| Compiled fake-backend smoke | Passed both modes; verified generated text and no listening TCP sockets on either agent |
| Ollama 0.32.0, `gemma4:e2b` | Passed both modes; returned `hello` |
| CLIProxyAPI 7.2.70, `claude-sonnet-4-6` | Passed both modes; returned `Hello.` |
| Authenticated TLS/WebSocket | Passed registration and inference after 31 seconds on the same connection |
| Certificate and host authentication | Untrusted certificates, wrong certificate hostnames, and missing credentials rejected |
| macOS ARM64/AMD64 and Linux ARM64/AMD64 | Binary archives cross-compiled with SHA-256 checksums |
| Native Linux tests | CI configured; not executed on this Mac |
| Hosts on separate physical networks | Not run; requires a reachable coordinator and a second network/host |

The latest Gemma run measured 6.775 seconds to the first byte for non-streaming
and 0.455 seconds for streaming. Claude measured 2.709 and 3.118 seconds,
respectively. These are smoke-test observations, not performance guarantees.
Current reports are `dist/local-real-smoke.json`, `dist/local-fake-smoke.json`,
and `dist/cloud-readiness-test-run.log`. Earlier Claude tests encountered 429;
the latest run passed using the same configured provider and account.

The separate-network test is deliberately not represented as complete by the
two local agent processes. Follow [the acceptance procedure](integration.md)
when the second host and coordinator address are available. No external server
was deployed or partner service modified during this implementation.
