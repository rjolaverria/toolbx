# M2-02 — Downstream MCP server over Streamable HTTP

**Milestone**: 2 — Downstream Toolbox MCP Server
**README references**: §4.4 (`server.http`), §4.6, §7 (Milestone 2)

## Goal

Expose Toolbox as a Streamable HTTP MCP server so HTTP-capable clients can connect to a running Toolbox instance.

## Deliverables

- `packages/mcp-gateway/src/downstream-server/http.ts` exporting `createDownstreamHttpServer(deps)`.
- Binds `host` / `port` / `path` from the config (`server.http`).
- Reuses the same handler set as the stdio variant (M2-03/04/05 share an inner `createHandlers()` factory).
- Returns a handle with `start()`, `stop()`, and the actual bound URL (helpful when port 0 is requested in tests).

## Acceptance criteria

- An MCP HTTP client can connect, complete `initialize`, and call `tools/list` against a running instance.
- Default bind is `127.0.0.1` — never `0.0.0.0` unless the user opts in. (Phase 1 only ships loopback; reject other hosts at config load until a future task allows them.)
- `stop()` drains in-flight requests and closes the listener.
- The server returns HTTP 4xx for non-MCP requests with a small JSON error body.

## Out of scope

- TLS termination (deploy behind a local reverse proxy if needed).
- Auth on the downstream server (Phase 1 assumes localhost only).

## Definition of done

- Acceptance criteria hold.
- Tests start the server on `127.0.0.1:0`, run an SDK HTTP client end-to-end, then stop.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M2-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
