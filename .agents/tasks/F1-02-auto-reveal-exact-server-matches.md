# F1-02 — Honor `progressiveDisclosure.autoRevealExactServerMatches` in search

**Milestone**: Phase 1 follow-ups
**SPECS references**: §2.4 (Progressive Disclosure)

## Goal

The config flag `progressiveDisclosure.autoRevealExactServerMatches` is already part of the schema and the search-tool comment header explicitly forecasts the wiring (see `packages/mcp-gateway/src/bootstrap-tools/search-tools.ts:18-25`). Today the flag has no runtime effect. This task lands the wiring those comments describe.

## Deliverables

- Update `packages/mcp-gateway/src/bootstrap-tools/search-tools.ts` so that when:
  - the inbound query exactly matches an enabled server's name (case-insensitive, post-trim), AND
  - `progressiveDisclosure.autoRevealExactServerMatches` is `true`,
  - the search tool calls `sessionVisibility.reveal(...)` for every tool exposed by that server before returning, and the response indicates the auto-reveal happened.
- Thread `SessionVisibility` into the search tool's deps the same way the existing reveal/hide tools receive it. No new singleton state.
- When the flag is `false` (default), behavior is unchanged: search returns ranked candidates without mutation.
- Update the header comment in `search-tools.ts` to describe the now-current behavior (drop the "intentionally not honoured here yet" language).

## Acceptance criteria

- With the flag set and a query of `"jira"` against a server named `jira`, every `jira__*` tool becomes visible to the session immediately and the next `tools/list` from that session reflects the change.
- With the flag set, a partial match (`"jir"`) does **not** auto-reveal anything.
- With the flag unset, an exact match does **not** auto-reveal anything.
- An auto-reveal triggers a single `notifications/tools/list_changed` per call (not one per tool) — uses the existing M4-06 debouncing.
- Tests cover all four cells of the (flag on/off) × (exact/partial match) matrix, plus the notification-emission assertion.

## Out of scope

- Auto-reveal triggered by anything other than an exact server-name match (e.g. exact tool-name match across servers). If usage demands it later, file a separate task.
- Persisting auto-reveal state across sessions.
- Updating bootstrap-tool descriptors to advertise auto-reveal — the flag is opt-in and config-driven; clients shouldn't need to know.

## Definition of done

- Acceptance criteria hold.
- The header comment in `search-tools.ts` no longer claims the behavior is deferred.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the F1-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
