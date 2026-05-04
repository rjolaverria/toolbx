# M1-03 — Upstream session lifecycle and reconnect

**Milestone**: 1 — Upstream Connection Manager
**SPECS references**: §2.5, §4.6, §7 (Milestone 1)

## Goal

Wrap the per-transport upstream clients (M1-01, M1-02) in a session manager that handles initialize, ping/keepalive, automatic reconnect with backoff, and clean shutdown. The session manager is what the rest of the system depends on; the raw transports stay private.

## Deliverables

- `packages/mcp-gateway/src/upstream-client/session.ts` exporting `createUpstreamSession(serverConfig, deps)`:
  - Selects stdio vs http transport based on the discriminant.
  - Drives `initialize`, captures the upstream's announced capabilities, and caches the initial `tools/list`.
  - Subscribes to `notifications/tools/list_changed` and re-fetches `tools/list` when received.
  - Periodic `ping` keepalive (configurable, default 30s).
  - Reconnect with exponential backoff (cap configurable; default 30s) on transport-level failures, but **not** on `auth_required` / `auth_expired` — those are terminal until config changes.
- Session emits `'status'` events whose payload matches `ServerStatus` (M1-04).

## Acceptance criteria

- A successful initialize transitions the session to `connected` and exposes the upstream tool list.
- Loss of the underlying transport triggers a reconnect attempt with backoff and the session reports `error` then `starting` then `connected`.
- An `auth_required` error stops reconnect attempts and reports `auth_required` until `restart()` is called.
- `dispose()` cleanly tears the session down: kills the upstream transport, cancels timers, removes listeners.

## Out of scope

- Token refresh / re-auth flows.
- Cross-process state (sessions live for the lifetime of the gateway process).

## Definition of done

- Acceptance criteria hold.
- Tests cover happy-path init, reconnect-after-crash, auth-required terminal state, and dispose idempotency.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M1-03 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
