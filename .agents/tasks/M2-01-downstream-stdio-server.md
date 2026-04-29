# M2-01 — Downstream MCP server over stdio

**Milestone**: 2 — Downstream Toolbox MCP Server
**README references**: §4.6, §4.8 (criteria 4, 5), §7 (Milestone 2)

## Goal

Expose Toolbox itself as an MCP server over stdio, so MCP clients (Claude, Codex, OpenCode) can connect by spawning `tlbx serve --stdio`.

## Deliverables

- `packages/mcp-gateway/src/downstream-server/stdio.ts` exporting `createDownstreamStdioServer(deps)`.
  - `deps` includes `{ config, statusRegistry, upstreamSessions, namespacing, logger }`.
- Wires `@modelcontextprotocol/sdk` server with the stdio transport.
- Hooks for the handlers added by M2-03 / M2-04 / M2-05.
- Process lifecycle: clean shutdown on SIGINT/SIGTERM and on stdin EOF.
- Stdout is reserved for MCP protocol traffic; **all** logging goes through stderr.

## Acceptance criteria

- A canonical MCP client connecting via the SDK's stdio transport completes `initialize` and receives Toolbox's announced capabilities.
- The server exits cleanly when the client closes stdin.
- A panic / unhandled rejection in a handler does not corrupt the protocol stream — the error becomes an MCP error response.

## Out of scope

- Tool implementation details (M2-04, M2-05).
- HTTP transport (M2-02).

## Definition of done

- Acceptance criteria hold.
- Tests use the SDK client against an in-process stdio server fixture.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M2-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
