# P2-02 — Dashboard screen

**Milestone**: Phase 2 — Electron UI
**SPECS references**: §5.3 (Dashboard)

## Goal

The first screen the user sees: at-a-glance ToolBox health.

## Deliverables

- Dashboard route in the renderer showing:
  - ToolBox status (running / stopped) with a start/stop control.
  - Local endpoint(s) for stdio and HTTP downstream servers.
  - Connected client count (stretch: which clients).
  - Enabled upstream servers count and a roll-up status indicator.
  - Total tool count.
  - Warnings/errors list.
  - Recent activity (most recent N tool calls / connect events).
- Live updates via the IPC subscription added in P2-01.

## Acceptance criteria

- Status indicators reflect `@toolbox/core` registry state within 1s of change.
- Start/stop button does not block the UI thread; long operations show a spinner.
- "Recent activity" shows newest first and caps at 50 entries.

## Out of scope

- Per-tool detail (Tool inventory in P2-04).
- Editing servers (Server manager in P2-03).

## Definition of done

- Acceptance criteria hold.
- Component tests cover the loading, empty, healthy, and degraded states.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
