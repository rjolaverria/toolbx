# M1-02 — Upstream Streamable HTTP MCP client

**Milestone**: 1 — Upstream Connection Manager
**README references**: §2.1, §4.4 (`type: 'http'`), §4.6 (Must Have), §7 (Milestone 1)

## Goal

Implement an upstream MCP client that talks to a Streamable HTTP MCP server. Mirrors the surface of M1-01 so callers do not care which transport an upstream server uses.

## Deliverables

- `packages/mcp-gateway/src/upstream-client/http.ts` exporting `createHttpUpstreamClient(config, deps)`.
- Uses the Streamable HTTP transport from `@modelcontextprotocol/sdk`.
- Same client interface as M1-01: `connect`, `disconnect`, `listTools`, `callTool`, `ping`, `on`.
- Auth handling for Phase 1:
  - `auth: { type: 'none' }` — no headers.
  - `auth: { type: 'bearer', tokenEnv: 'NAME' }` — read token from `process.env[NAME]`; surface a typed `auth_required` error if missing.
- Resolve `${env:VAR}` placeholders in `headers`.

## Acceptance criteria

- `connect()` rejects with a typed `auth_required` error when a bearer token env var is unset.
- `connect()` rejects with a typed `error` when the URL is unreachable or returns a non-MCP response.
- `callTool` enforces the timeout configured on the server (`timeoutMs`) and reports which upstream tool timed out.
- The client is interface-compatible with the stdio variant — both can be assigned to a shared `UpstreamClient` type.

## Out of scope

- OAuth flows (deferred per README §4.6).
- Refreshing expired tokens automatically (M1-03 may surface `auth_expired`, refresh is later).

## Definition of done

- Acceptance criteria hold.
- Unit tests stand up a local HTTP MCP fixture (or mock the SDK transport) and exercise the full client surface plus the `auth_required` and unreachable-host error paths.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M1-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
