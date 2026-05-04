# P2-05 — Progressive disclosure settings screen

**Milestone**: Phase 2 — Electron UI
**SPECS references**: §5.3 (Progressive Disclosure), §5.4 (criterion 7)

## Goal

A settings screen for the `progressiveDisclosure` block of the config.

## Deliverables

- Settings route in the renderer with form controls for:
  - Enabled / disabled
  - Mode: session / global
  - Bootstrap tools visible (toggle)
  - Max search results (number input)
  - Always reveal tools from selected servers (multi-select against enabled servers)
  - Pinned tools (multi-select against the tool inventory)
- Saves go through the same Zod schema as the CLI's `tlbx config set`.
- Inline preview area showing what the next `tools/list` would return for the current session given the selected settings.

## Acceptance criteria

- Saving changes persists to the global config and triggers `notifications/tools/list_changed` on connected sessions (verified in M4-06 integration tests; this screen just exercises the toggle).
- Preview reflects edits live without requiring save.
- Validation errors are inline and prevent save.

## Out of scope

- Server-specific overrides (deferred).
- Per-client (Claude vs Codex) settings.

## Definition of done

- Acceptance criteria hold.
- Component tests cover toggling each control and the preview update.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
