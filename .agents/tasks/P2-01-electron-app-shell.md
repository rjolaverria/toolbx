# P2-01 — Electron app shell wired to `@toolbox/core`

**Milestone**: Phase 2 — Electron UI
**SPECS references**: §3.2, §5.1, §5.2, §7 (Milestone 6)

## Goal

Bootstrap the Electron desktop app: main process owns ToolBox lifecycle via `@toolbox/core`; renderer is React + Vite + Tailwind + shadcn/ui served through TanStack Router. The shell displays an empty dashboard route and exposes the IPC API for later screens.

## Deliverables

- `apps/desktop/` Electron app (new). Two processes:
  - **Main** — imports `@toolbox/core`, manages config, starts/stops ToolBox proxy, monitors server status, exposes IPC handlers (read config, list servers, list tools, get status, subscribe to events, start/stop serve, etc.).
  - **Renderer** — Vite + React + Tailwind + shadcn/ui + TanStack Router + TanStack Query. Strict CSP, no Node integration, contextBridge-only.
- A typed IPC contract (`packages/ui-shared/src/ipc/`) shared between main and renderer.
- Build and packaging scripts (dev, prod) that work on macOS and Linux at a minimum; Windows is a stretch.
- The desktop app uses the same global config file as the CLI — never a separate config.

## Acceptance criteria

- `pnpm --filter desktop dev` opens an Electron window that renders an empty dashboard route.
- The renderer cannot import Node modules directly; only the typed IPC bridge is available.
- Closing the window cleanly disposes any running upstream sessions in the main process.
- The CLI and the desktop app, run alongside each other, observe the same config file.

## Out of scope

- Any concrete screen content beyond the dashboard placeholder (those are P2-02..P2-07).
- Auto-update.

## Definition of done

- Acceptance criteria hold.
- IPC contract has type tests; main-process logic that wraps `@toolbox/core` has unit tests.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
