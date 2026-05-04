# M1-04 — Server status registry and state machine

**Milestone**: 1 — Upstream Connection Manager
**SPECS references**: §2.5, §4.8 (criterion 11), §7 (Milestone 1)

## Goal

A single in-memory registry that tracks one `ServerStatus` per configured upstream server, plus the metadata listed in SPECS §2.5 (transport type, enabled state, tool count, last connected, last error, recent log lines). The registry is the source of truth for `tlbx status` and any future UI.

## Deliverables

- `packages/core/src/server-status/registry.ts` exporting:
  - `ServerStatus` type from SPECS §2.5 (`'disabled' | 'starting' | 'connected' | 'auth_required' | 'auth_expired' | 'error' | 'stopped'`) — already lives in `packages/core/src/server-status/types.ts`.
  - `ServerStatusEntry` interface holding `name`, `transport`, `enabled`, `status`, `authStatus`, `toolCount`, `lastConnectedAt`, `lastError`, `recentLogs`.
  - `createStatusRegistry(initialConfig)` returning `{ get, list, update, subscribe }`.
- `packages/core/src/server-status/state-machine.ts` defining valid `ServerStatus` transitions and a `transition(prev, event)` reducer used by both the upstream session and the registry.
- Integration: `createUpstreamSession` (M1-03) emits status events that the registry consumes via `update`.

## Acceptance criteria

- Invalid transitions (e.g. `disabled → connected`) are rejected by the reducer and produce a typed error.
- `subscribe(callback)` fires on every entry change and returns an unsubscribe function.
- `recentLogs` is bounded (default 100 lines) and rotates oldest-first.
- The registry holds entries for **every** server in config, even disabled ones — disabled servers report `status: 'disabled'`.

## Out of scope

- Persistence to disk — registry is purely runtime.
- Per-tool status tracking (separate concern in M4).

## Definition of done

- Acceptance criteria hold.
- Unit tests cover the state machine transitions exhaustively and exercise the registry pub/sub.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M1-04 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
