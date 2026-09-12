# Relay protocol v1

This is the integration boundary between a host agent and the partner's server.
The reference implementation uses `github.com/coder/websocket`; a server in any
language can implement the same JSON messages. See `../protocol/schema.json` and
`protocol-examples.json` for machine-readable structure and examples.

## Connection and authentication

The agent initiates `GET /relay/v1/connect` with `Authorization: Bearer <host-key>`
and upgrades to WebSocket. Use WSS outside loopback. Reject unauthorized upgrades
with 401 before accepting the socket. Map each credential to exactly one host ID;
never trust the claimed `host_id` alone. Buyer credentials are a separate namespace.

All application frames are UTF-8 JSON **text** WebSocket messages, with
`version: 1` and `type`. Binary frames, unknown top-level fields, invalid message
types, and unsupported versions close the connection. Compression is disabled.
The maximum received frame is 1,114,112 bytes (1 MiB + 64 KiB envelope allowance).
Close connections that exceed limits; don't allocate buffers from supplied sizes.

Within ten seconds, the agent sends `hello` with its authenticated `host_id`,
agent version, OS, architecture, and backend catalog. The server replies with
`welcome` echoing that host ID. No work is assigned before `welcome` is sent.
A duplicate live host ID is rejected; it does not evict the original session.
An absent catalog means no capacity. Clients used only for diagnostics may
authenticate the upgrade and close without registering.

Each catalog entry contains `id`, `kind` (`ollama` or `cliproxyapi`), `source`
(`local` or `provider`, respectively), `ready`, `capacity`, `available`, and models.
Each model contains `id` (backend ID + `/` + native name), `name`, and a required
`digest` for local models. Catalog IDs must be unique. The source label describes
the adapter; it does not attest to the actual execution location behind a proxy.

## Messages and direction

| Type | Direction | Additional fields |
|---|---|---|
| `hello` | Host → server | `host_id`, optional `agent_version`, `os`, `arch`, `backends` |
| `welcome` | Server → host | `host_id` |
| `catalog` | Host → server | `backends` (whole snapshot; absent means empty) |
| `heartbeat` | Host → server | Increasing positive `heartbeat_id` |
| `heartbeat_ack` | Server → host | Matching `heartbeat_id` |
| `request` | Server → host | `request_id`, `attempt_id`, `backend_id`, `model`, `timeout_ms`, `start_timeout_ms`, `body` |
| `response_start` | Host → server | `attempt_id`, HTTP `status`, `content_type` |
| `response_chunk` | Host → server | `attempt_id`, increasing `seq`, base64 `data` |
| `response_end` | Host → server | `attempt_id`, optional `usage` |
| `error` | Host → server | `attempt_id`, safe `code`, optional `retryable`, optional `usage` |
| `cancel` | Server → host | `attempt_id` |

`request_id` identifies the buyer's logical request; each execution attempt has a
different `attempt_id`. IDs are opaque strings up to 128 characters. IDs are
scoped to a connection for replay rejection, but servers should generate globally
unique values. The agent remembers every attempted ID, including rejected and
completed assignments. Reusing one closes the connection. After 100,000 IDs,
the agent closes and reconnects to bound memory. There is no durable deduplication
or attempt resumption across connections.

`body` is the Chat Completions JSON object, limited to 1 MiB in its wire encoding.
`model` is a currently advertised public model ID; `backend_id` identifies its
adapter. The agent substitutes the native model name in `body.model`, preserving
the remaining JSON values, including extensions and tools. Inference requests
cannot contain destination URLs or HTTP headers in the transport envelope.

Timeouts are positive integer milliseconds. `start_timeout_ms <= timeout_ms` and
`timeout_ms <= 86,400,000`. The host caps both against its local configuration.
The server subtracts elapsed time before retrying; a retry never resets the
logical request's total deadline. The response-start timeout measures receiving
HTTP response headers from the backend. The total deadline also bounds stalled
body reads and provider inference. HTTP write deadlines are five seconds.

## Responses, capacity, and cancellation

For a normal attempt, expect exactly one `response_start`, zero or more ordered
`response_chunk` messages, and one terminal `response_end` or `error`. An immediate
rejection can send `error` without a start message. `seq` starts at 1 and increments
by 1 for each chunk. HTTP status is 200–599; content type is `application/json` or
`text/event-stream`. HTTP redirects from a backend are not followed and cannot
expose its credentials to another destination.

Decoded chunks contain arbitrary bytes, including partial UTF-8 characters,
partial JSON, CRLF, SSE comments and event boundaries. Forward decoded bytes
unchanged, in sequence. Do not interpret a chunk as a token or a complete SSE
event. Maximum decoded chunk size is 32,768 bytes. Track queued bytes rather than
only counting messages. At most 262,144 response bytes per attempt may be queued;
the agent uses synchronous chunk sends, and the reference server uses a bounded
queue. Control traffic is processed separately from buyer HTTP writes.

No provider authentication fields or backend error bodies are sent upstream.
For backend HTTP statuses >=400, the agent sends only `response_start` with that
status followed by `response_end`; the server supplies a generic JSON error.
For successful SSE, the agent requires `[DONE]` before EOF. A missing marker or
upstream stream error becomes `stream_interrupted`.

`usage`, when available, is an object containing nonnegative integer
`prompt_tokens`, `completion_tokens`, and/or `total_tokens`. Missing values are
omitted, never estimated from bytes or chunks. Observing usage never delays the
response; very large events or non-streaming bodies may exceed the bounded
observer and leave usage unknown. These counts are unverified backend claims.

The coordinator reserves capacity when dispatching and retains it until a
terminal message or connection loss. Catalog `available` is advisory; compute
dispatch capacity from `capacity` minus outstanding reservations to avoid races
with stale snapshots. The agent separately enforces its own slots and may reject
an assignment with `busy`. Changes to config require a restart; discovery sends
a whole catalog snapshot every 30 seconds.

On buyer disconnect, deadline, or slow consumer, send `cancel`. The agent closes
the HTTP response/request, releases its local slot, and then sends an `error`
with `code: cancelled`. A completion that already won the cancellation race is
also terminal acknowledgement. Unknown/finished cancellations are harmless.
Discard subsequent chunks of abandoned attempts, but keep consuming terminal
messages. If no terminal acknowledgement arrives within five seconds after the
cancel is written, disconnect the host. Cancellation beyond the runtime's HTTP
connection is backend-dependent.

## Heartbeats, disconnects, and retry boundaries

Hosts send heartbeats every five seconds. Only a new valid acknowledgement of a
sent heartbeat refreshes the host's liveness timer. After ten seconds without an
acknowledgement, the agent closes its socket and cancels all active HTTP calls.
The server similarly disconnects a host silent for ten seconds. The agent
reconnects with exponential backoff and jitter, capped at 30 seconds, resets the
backoff after a minute-long connection, and advertises fresh capacity.

The reference gateway immediately routes to an eligible host with a free slot,
using round-robin selection; otherwise it returns 503. There is no job queue.
Only the coordinator retries, at most once, before committing the buyer's HTTP
response. Eligible retries include disconnects, timeouts, busy/unavailable hosts,
and HTTP 408, 429, 500, 502, 503, 504. HTTP 400/401/403 and explicit model/input
errors are not retryable. Retry on another host, with identical request content
and source/kind; local models must have identical digests.

Once any buyer response bytes are sent, never retry or replace the generation.
For SSE, append a generic `data: {"error": ...}` event and close, with no fabricated
success marker. If the backend ended in the middle of an SSE event, that partial
event may also be invalid; clients must treat the stream as failed. For partial
non-streaming JSON, abort the HTTP connection/stream instead of appending JSON.

Before response commitment, return ordinary JSON errors using
`{"error":{"type":"relay_error","code":"...","message":"..."}}`.
Agent error codes include `busy`, `backend_unavailable`, `model_not_allowed`,
`invalid_request`, `backend_failed`, `invalid_backend_response`, `start_timeout`,
`deadline_exceeded`, `cancelled`, and `stream_interrupted`. Gateway-only failures
include `no_capacity`, `host_disconnected`, `slow_consumer`, and
`empty_backend_response`. Error text is fixed, never copied from backend errors.
