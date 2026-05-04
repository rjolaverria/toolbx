# M4-02 — Session-visible tool registry

**Milestone**: 4 — Progressive Disclosure
**SPECS references**: §2.4, §4.4 (`progressiveDisclosure.mode`), §7 (Milestone 4)

## Goal

Per-session state that records which exposed tools the current MCP client has revealed. Used by `tools/list` (M4-07), the reveal/hide bootstrap tools (M4-04), and `tools/call` gating (M2-05 already plumbed the hook).

## Deliverables

- `packages/core/src/disclosure/session-visibility.ts` exporting:
  - `createSessionVisibility(options)` returning `{ list, reveal, hide, isVisible, snapshot, reset, on }`.
  - `mode: 'session' | 'global'`. `session` keeps state per-MCP-session; `global` shares state across sessions on this ToolBox instance.
- Bootstrap tools (per SPECS §2.4) are always visible regardless of reveal/hide.
- `autoRevealExactServerMatches: true` reveals an entire server's tool set when its server name is exactly searched (used by M4-03's `search_tools`).
- Emits `'change'` events that M4-06 will translate to `notifications/tools/list_changed`.

## Acceptance criteria

- New sessions start with an empty revealed set in `mode: 'session'`.
- Revealing a tool that's already visible is a no-op and emits no event.
- Hiding a tool that's not currently revealed is a no-op and emits no event.
- Bootstrap tools are reported as visible by `isVisible` regardless of state.
- `reset()` empties the revealed set and emits a single `change` event.

## Out of scope

- Persistence of revealed-tool state across ToolBox restarts.
- "Pinned" / "always visible" tools — listed in §5.3 but a Phase 2 UI concern.

## Definition of done

- Acceptance criteria hold.
- Unit tests cover both modes plus event emission semantics.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M4-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
