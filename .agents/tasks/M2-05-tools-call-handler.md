# M2-05 — `tools/call` handler with upstream routing

**Milestone**: 2 — Downstream Toolbox MCP Server
**README references**: §2.3, §4.6, §4.8 (criterion 7)

## Goal

Wire the downstream `tools/call` to the correct upstream session, translating namespaced tool names back to upstream names. Concrete error / timeout policy lives in M3-03.

## Deliverables

- `packages/mcp-gateway/src/downstream-server/handlers/tools-call.ts`:
  - Looks up the call's `name` in the tool registry (M2-04).
  - Validates the arguments against the cached upstream `inputSchema` for that tool. Reject with a structured MCP error when validation fails.
  - Calls the upstream session's `callTool(upstreamName, args)` and forwards the result.
- Hook into the shared `Session` object so calls in disclosure mode are gated by the session's revealed-tool set (the gating itself lands in M4-07).

## Acceptance criteria

- Calling `jira__search_issues` with valid args reaches the Jira upstream session as `search_issues` with the same args.
- Calling an unknown tool name returns a clear MCP error (e.g. `Method not found` style) without crashing.
- Calling a tool whose upstream session is currently disconnected returns an MCP error referencing the upstream server name.
- Result content is forwarded byte-for-byte to the downstream client.

## Out of scope

- Streaming partial results / progress notifications (deferred per README §4.6 "Should Have").
- Per-call retries (M3-03 decides the retry policy).

## Definition of done

- Acceptance criteria hold.
- Tests assert routing through fake upstream sessions plus the unknown-tool and disconnected-server error paths.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M2-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
