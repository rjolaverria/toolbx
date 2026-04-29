# M1-01 — Upstream stdio MCP client

**Milestone**: 1 — Upstream Connection Manager
**README references**: §2.1, §4.4 (`type: 'stdio'`), §4.6 (Must Have), §7 (Milestone 1)

## Goal

Implement an upstream MCP client that spawns and talks to a stdio-based MCP server, using `@modelcontextprotocol/sdk`. This is the primary transport for upstream servers like `@modelcontextprotocol/server-github`.

## Deliverables

- `packages/mcp-gateway/src/upstream-client/stdio.ts` exporting `createStdioUpstreamClient(config, deps)`.
  - `config` is a `StdioServerConfig` discriminant variant from `@toolbox/core`.
  - `deps` includes `{ logger }`.
- The client owns the child process lifecycle: spawn, stdin/stdout pipes, signal handling, `kill()` on disposal.
- Surface a small interface on the returned client:
  - `connect()` — spawn + initialize.
  - `disconnect()` — close transport and kill the child.
  - `listTools()` — proxy of MCP `tools/list`.
  - `callTool(name, args, opts)` — proxy of MCP `tools/call` with timeout.
  - `ping()` — proxy of MCP `ping`.
  - `on(event, handler)` for `'tools_list_changed'`, `'log'`, `'exit'`.
- Resolve env var placeholders of the form `${env:VAR_NAME}` in `env` values at spawn time. Missing required env vars must surface as a typed error.

## Acceptance criteria

- `connect()` rejects with a descriptive error if the command is missing or exits before initialize completes.
- `disconnect()` is idempotent and never leaves an orphan child (verified in tests by spawning a long-running script).
- Timeouts on `callTool` are enforced and report which upstream tool timed out.
- Stdout from the child process is consumed exclusively as MCP traffic; stderr is forwarded to the injected logger at `debug` level.

## Out of scope

- Auto-restart on upstream crash (handled in M1-03).
- HTTP transport (M1-02).

## Definition of done

- Acceptance criteria hold.
- Unit tests use a fake stdio MCP server (a small Node script in `__fixtures__`) to exercise `connect`, `listTools`, `callTool`, and `disconnect`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M1-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
