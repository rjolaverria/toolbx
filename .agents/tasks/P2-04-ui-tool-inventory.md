# P2-04 — Tool inventory screen

**Milestone**: Phase 2 — Electron UI
**README references**: §5.3 (Tools), §5.4 (criteria 6, 8)

## Goal

A searchable, filterable list of every tool Toolbox exposes — across servers, with reveal/hide and enable/disable controls.

## Deliverables

- Tools route in the renderer with a table containing the columns from README §5.3: Toolbox name, original server, original upstream tool name, description, input schema preview, enabled state, revealed state.
- Search uses M4-01's ranking via IPC (no separate UI-side search — keep ranking consistent with the bootstrap search tool).
- Per-row actions: search, reveal, hide, pin always visible (visual only for Phase 2 unless backed in M4 later), disable globally, copy tool name.
- Filter chips for `server`, `enabled`, `revealed`.

## Acceptance criteria

- Searching matches the CLI's `tlbx tools search` output exactly given the same query.
- Toggling Disable persists through `@toolbox/core` and is reflected in the next `tools/list` response.
- Copy tool name copies the exposed (`server__tool`) form.
- Empty state explains how to add servers.

## Out of scope

- Custom tool import UI (P3 territory).
- Tool execution from the UI.

## Definition of done

- Acceptance criteria hold.
- Component tests cover the table, search behavior, and the row actions.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-04 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
