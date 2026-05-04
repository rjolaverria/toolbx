# M2-03 — `initialize`, `notifications/initialized`, `ping` handlers

**Milestone**: 2 — Downstream ToolBox MCP Server
**SPECS references**: §4.6 (Must Have), §7 (Milestone 2)

## Goal

Implement the basic MCP lifecycle handlers shared by both stdio and HTTP downstream servers.

## Deliverables

- `packages/mcp-gateway/src/downstream-server/handlers/initialize.ts`:
  - Returns ToolBox's announced capabilities. Phase 1 must include `tools` and `logging`. Resources / prompts are reserved for a later milestone.
  - Reports `serverInfo` as `{ name: 'toolbox', version: <package version> }`.
  - Negotiates protocol version per the SDK rules.
- Handler for `notifications/initialized` that flips a per-session "ready" flag. `tools/call` etc. must reject before this notification arrives.
- Handler for `ping` that simply replies.
- A small `Session` object (in-memory) that the handlers mutate. The Session is the unit of progressive-disclosure state in M4.

## Acceptance criteria

- An MCP client that issues `tools/call` before `initialize` + `notifications/initialized` receives an MCP error.
- `initialize` reports the correct version string from `apps/cli`'s `package.json` (or a single source-of-truth helper).
- `ping` round-trips successfully against both stdio and HTTP transports.

## Out of scope

- Cancellation and progress (deferred per SPECS §4.6 "Should Have").
- Sampling and elicitation (deferred per SPECS §4.6 "Defer").

## Definition of done

- Acceptance criteria hold.
- Tests cover initialize / initialized / ping plus the pre-init rejection path.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M2-03 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
