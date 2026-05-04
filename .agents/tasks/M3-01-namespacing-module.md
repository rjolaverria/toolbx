# M3-01 — Namespacing module

**Milestone**: 3 — Proxy Routing
**SPECS references**: §2.3, §4.4 (`namespacing` block), §4.8 (criterion 12), §9 (principle 4)

## Goal

A small, pure module that converts between upstream tool names and ToolBox-exposed namespaced names, and detects collisions across upstream servers. The entire proxy depends on this — keep it deterministic and well-tested.

## Deliverables

- `packages/core/src/namespace/index.ts` exporting:
  - `formatExposedName(serverName, upstreamName, options)`.
  - `parseExposedName(exposedName, options)` returning `{ serverName, upstreamName } | null`.
  - `detectCollisions(toolsByServer, options)` returning a list of conflicts.
- Configuration is the `namespacing` block from the config schema (`separator`, `format`, `collisionStrategy`).
  - For Phase 1, only `separator: '__'` and `format: 'server__tool'` are supported. Other values must throw at config load (M0-01) — keep this module strict but flexible enough to grow later.
- `collisionStrategy: 'error'` causes `detectCollisions` to surface conflicts; the rest of the system decides what to do with them.

## Acceptance criteria

- Round trip: for any valid `(serverName, upstreamName)` pair, `parseExposedName(formatExposedName(...))` returns the original pair.
- Names with the separator `__` inside the upstream tool name are still parseable — the first `__` after the server name is the boundary.
- A server name that itself contains `__` is rejected at config load time (validation belongs in M0-01; document this constraint here).
- `detectCollisions` handles the case where two upstream servers register the same exposed name and reports each pair clearly.

## Out of scope

- Renaming exposed tools at proxy time (collisions are config errors).
- Alternate format strings (deferred until needed).

## Definition of done

- Acceptance criteria hold.
- Property-based or table-driven tests cover format / parse round-trips and the collision detector.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M3-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
