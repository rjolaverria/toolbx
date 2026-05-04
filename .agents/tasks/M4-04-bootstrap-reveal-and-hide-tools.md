# M4-04 — Bootstrap tools: `toolbox__reveal_tools` and `toolbox__hide_tools`

**Milestone**: 4 — Progressive Disclosure
**SPECS references**: §2.4

## Goal

Two bootstrap tools that mutate the session's revealed-tool set. After a call, the downstream client's next `tools/list` reflects the change.

## Deliverables

- `packages/mcp-gateway/src/bootstrap-tools/reveal-tools.ts`:
  - Input: `{ tools: string[] }` (exposed names).
  - Validates each name against the live tool registry; rejects unknown names with a clear error listing the bad ones.
  - Calls `sessionVisibility.reveal(...)` from M4-02.
  - Triggers `notifications/tools/list_changed` on success (the actual notification logic is M4-06; this tool just calls into the session).
- `packages/mcp-gateway/src/bootstrap-tools/hide-tools.ts`:
  - Input: `{ tools: string[] }`.
  - Calls `sessionVisibility.hide(...)`.
  - Returns the new visible-tool set summary.
- Both tools refuse to operate on bootstrap tool names — they cannot be hidden.

## Acceptance criteria

- After `reveal_tools({ tools: ['jira__search_issues'] })` the session reports `isVisible('jira__search_issues') === true`.
- After `hide_tools(...)` the same name disappears from `tools/list`.
- Attempting to reveal an unknown name returns an error that names every unknown entry.
- Attempting to hide a bootstrap tool returns an error and does not mutate state.

## Out of scope

- Persisting reveal state across restarts.
- Bulk reveal-by-glob (could be added later if usage demands it).

## Definition of done

- Acceptance criteria hold.
- Tests cover happy paths, unknown-tool rejection, and bootstrap-tool guard.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M4-04 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
