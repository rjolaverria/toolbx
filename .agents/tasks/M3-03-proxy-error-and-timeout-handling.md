# M3-03 — Timeout, error, and disabled-server handling for proxied calls

**Milestone**: 3 — Proxy Routing
**README references**: §4.4 (`timeoutMs`), §4.6 (Must Have), §7 (Milestone 3)

## Goal

Make the proxy's failure modes predictable and visible. Apply per-server timeouts, translate upstream errors into well-formed MCP errors, and never leak a hung upstream call into the downstream client.

## Deliverables

- Extend `routeToolCall` (M3-02) to accept a per-server `timeoutMs` (from config) and abort the upstream call when exceeded. Aborted calls return `{ kind: 'upstream_error', error: { code: 'timeout', timeoutMs, server, tool } }`.
- Translate upstream MCP errors into the same `upstream_error` shape, preserving the upstream `code`/`message` when present.
- `tools/call` handler in M2-05 maps `RouteResult` → MCP error:
  - `unknown_tool` → MCP `Method not found`.
  - `server_unavailable` → MCP `Server error` with `data: { server, status }`.
  - `invalid_args` → MCP `Invalid params` with the Zod-formatted issue list.
  - `upstream_error` → MCP `Server error` with the upstream details.
- Recently completed tool calls are logged via the M0-02 logger at `info` (success) or `warn` (failure), with `server`, `tool`, `durationMs`, and `outcome`.

## Acceptance criteria

- A call to a tool whose upstream session takes longer than `timeoutMs` is aborted on the upstream side and reported as `timeout` to the client within ±100ms of the configured value.
- A disabled or disconnected upstream server returns `server_unavailable` without ever attempting the upstream call.
- Upstream MCP errors are not silently swallowed — every failure produces both a structured log entry and a downstream MCP error.
- The downstream client never observes Toolbox crashing because of an upstream failure.

## Out of scope

- Retries (would change ordering semantics; defer until there's a real-world need).
- Backpressure / queueing across many concurrent calls.

## Definition of done

- Acceptance criteria hold.
- Tests use a fake upstream session that simulates slow responses, errors, and crashes.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M3-03 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
