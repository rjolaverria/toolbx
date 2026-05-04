# P2-07 — Logs screen with filters

**Milestone**: Phase 2 — Electron UI
**SPECS references**: §5.3 (Logs), §5.4 (criterion 10)

## Goal

A live, filterable logs view that surfaces what's happening across upstream sessions, downstream clients, and progressive disclosure events.

## Deliverables

- Logs route showing connection logs, tool calls, auth events, upstream errors, client sessions, and reveal/hide events from the M0-02 logger plus the M3-03 call audit log.
- Filter controls: server, client, tool, status, time range.
- Tail mode that auto-scrolls; pause-on-hover; "Jump to bottom" button.
- Each row expands to show structured details (request payload preview for tool calls — redact `tokenEnv` values).

## Acceptance criteria

- Logs render at >100 entries/second without UI jank (use windowed list rendering).
- Filters compose via AND.
- Sensitive fields (env-var-derived secrets, `Authorization` headers) are never displayed verbatim.

## Out of scope

- Log persistence beyond an in-memory ring buffer (configurable size).
- Log export beyond copy-to-clipboard.

## Definition of done

- Acceptance criteria hold.
- Component tests cover filter composition, tail mode, and secret redaction.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-07 checkbox in `.agents/TASKS.md` is updated with the closing commit hash. After this lands, mark Phase 2 (§5.4 acceptance criteria 1–11) as complete in `.agents/TASKS.md`.
