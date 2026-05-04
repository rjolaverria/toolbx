# M2-05 — `tools/call` handler with upstream routing

**Milestone**: 2 — Downstream ToolBox MCP Server
**SPECS references**: §2.3, §4.6, §4.8 (criterion 7)

## Goal

Wire the downstream `tools/call` to the correct upstream session, translating namespaced tool names back to upstream names. The handler is a thin proxy: it does not validate or reshape arguments or results — the upstream server owns both. Concrete error / timeout policy lives in M3-03.

## Deliverables

- `packages/mcp-gateway/src/downstream-server/handlers/tools-call.ts`:
  - Looks up the call's `name` in the tool registry (M2-04) to recover `(serverName, upstreamName)`.
  - Resolves the upstream session via an injected `UpstreamSessionLookup` seam (the real implementation is wired in M2-06's `tlbx serve`).
  - Calls the upstream session's `callTool(upstreamName, args)` and forwards the result object unchanged. Argument validation is deliberately delegated to the upstream server.
- A one-line comment marking where M4-07 will gate calls by the session's revealed-tool set (gating itself lands in M4-07; no state added here).

## Acceptance criteria

- Calling `jira__search_issues` with args reaches the Jira upstream session as `search_issues` with the same args.
- Calling an unknown tool name returns a clear MCP error (`MethodNotFound` style) without crashing.
- Calling a tool whose upstream session is missing or not `connected` returns an MCP error referencing the upstream server name.
- The upstream's result object (including `content`, `isError`, `structuredContent`) is forwarded byte-for-byte to the downstream client.
- Calling before `notifications/initialized` is rejected with `InvalidRequest`, matching the `tools/list` lifecycle gate.

## Out of scope

- Argument validation against `inputSchema` — the upstream server is the source of truth and will reject bad inputs itself.
- Streaming partial results / progress notifications (deferred per SPECS §4.6 "Should Have").
- Per-call retries and timeout policy (M3-03 decides).
- Wiring a real `UpstreamSessionLookup` to the connection manager (M2-06).

## Definition of done

- Acceptance criteria hold.
- Tests assert routing through fake upstream sessions plus the unknown-tool and disconnected-server error paths.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M2-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
