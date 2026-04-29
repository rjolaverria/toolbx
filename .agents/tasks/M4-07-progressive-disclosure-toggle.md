# M4-07 — Progressive disclosure config toggle in `tools/list`

**Milestone**: 4 — Progressive Disclosure
**README references**: §2.4, §4.4 (`progressiveDisclosure`), §4.8 (criteria 8, 9, 10)

## Goal

Combine the registry, session visibility, and bootstrap tools into the final `tools/list` semantics. With disclosure on, only bootstrap tools + revealed tools are returned. With it off, everything enabled is returned.

## Deliverables

- Update `packages/mcp-gateway/src/downstream-server/handlers/tools-list.ts` to branch on `config.progressiveDisclosure.enabled`:
  - Off → behavior from M2-04.
  - On → bootstrap tools (from `progressiveDisclosure.bootstrapTools`) + tools currently visible per `sessionVisibility.list()`.
- Update `tools/call` (M2-05) to refuse calls to non-visible tools when disclosure is on, returning a clear MCP error suggesting the agent reveal the tool first.
- Honor `autoRevealExactServerMatches` and `bootstrapTools` flags from config.

## Acceptance criteria

- With disclosure on and no reveals, `tools/list` returns only bootstrap tools.
- With disclosure on after `reveal_tools(['jira__search_issues'])`, `tools/list` returns bootstrap tools + `jira__search_issues`.
- With disclosure off, `tools/list` matches the M2-04 output regardless of session reveal state.
- Toggling `progressiveDisclosure.enabled` via `tlbx config set` (M5-03) takes effect on the next `tools/list` and sends `tools/list_changed`.

## Out of scope

- Per-server disclosure overrides (could come later).
- A "skim" mode that returns truncated descriptions in disclosure mode.

## Definition of done

- All acceptance criteria above hold and Phase 1 acceptance criteria 8, 9, 10 from README §4.8 are satisfied.
- Tests cover both modes plus the toggle transition.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M4-07 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
