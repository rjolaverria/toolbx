# M5-06 — End-to-end MCP client integration tests

**Milestone**: 5 — Client Compatibility & UX Polish
**README references**: §4.8 (all criteria), §7 (Milestone 5)

## Goal

A small but real integration test suite that runs Toolbox end-to-end and verifies the Phase 1 acceptance criteria from README §4.8.

## Deliverables

- `apps/cli/test/integration/` directory with Vitest tests that:
  - Spin up Toolbox on stdio with a fixture upstream stdio server (the same fixture from M1-01).
  - Use `@modelcontextprotocol/sdk` as a client to drive `initialize`, `tools/list`, `tools/call`, `notifications/tools/list_changed`.
  - Repeat for the HTTP downstream variant against an HTTP upstream fixture.
  - Cover progressive-disclosure on/off paths and reveal/hide round trips.
  - Assert namespace collision detection by configuring two upstream servers that produce the same exposed name.
- A `pnpm test:integration` script wired through Turbo (tagged so it can be run separately from unit tests).

## Acceptance criteria

- Every Phase 1 acceptance criterion in README §4.8 is exercised by at least one integration test that fails before the underlying milestone task lands and passes after.
- The suite runs in under 60 seconds on a developer laptop.
- No test depends on real network access; everything is fixture-based.

## Out of scope

- Cross-platform CI matrix beyond what the existing CI already does.
- Performance benchmarks (would be a separate task if/when it matters).

## Definition of done

- Acceptance criteria hold.
- `pnpm test:integration` is green locally and in CI.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M5-06 checkbox in `.agents/TASKS.md` is updated with the closing commit hash. After this lands, mark Phase 1 as complete in `.agents/TASKS.md`.
