# F1-05 — Gateway-level integration tests

**Milestone**: Phase 1 follow-ups
**SPECS references**: §4.8

## Goal

Today's only end-to-end coverage lives under `apps/cli/test/integration/`, which exercises the gateway transitively through the CLI. That misses regressions in the gateway's wire-protocol behavior unless the CLI happens to surface them. Add a dedicated integration suite that drives the gateway directly so wire-protocol regressions fail at the layer they originate.

## Deliverables

- New directory `packages/mcp-gateway/test/integration/` with Vitest tests using the same fixture pattern as the CLI integration suite (`apps/cli/test/integration/`). Tests must run via `pnpm test:integration` (already wired through Turbo per M5-06).
- Coverage matrix:
  - **Stdio happy path**: real upstream stdio fixture + real downstream stdio client driven by `@modelcontextprotocol/sdk`. `initialize`, `tools/list`, `tools/call`, `notifications/tools/list_changed`.
  - **HTTP happy path**: same matrix over the HTTP transport.
  - **Reconnect after upstream crash**: kill the upstream fixture mid-session; assert the gateway moves the server to `failed` then back to `connected` with a tools/list_changed notification when the fixture recovers.
  - **Bearer auth env var resolution**: HTTP upstream that requires `Authorization: Bearer $TOKEN`; assert the gateway resolves `${env:TOKEN}` and sends the header. Cover the missing-env-var case too — gateway must surface `auth_required`.
  - **Namespace collision**: two upstream servers producing the same exposed name; assert the registry reports the collision via the existing error type.
- No test depends on real network access — every upstream is a local fixture.
- Suite runs in under 30 seconds on a developer laptop.

## Acceptance criteria

- Every cell of the matrix is covered by at least one test that fails when the corresponding code path is regressed (verified by mutation: temporarily break the path, watch the test go red).
- `pnpm test:integration` is green locally and in CI.
- The gateway suite and the CLI integration suite share fixtures where reasonable; no duplicated stub servers.

## Out of scope

- Performance / load testing.
- Cross-process integration with the future Electron app (Phase 2 territory).
- Replacing the CLI integration suite — that suite tests CLI plumbing on top of the runtime, which is still valuable.

## Definition of done

- Acceptance criteria hold.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run`, and `pnpm test:integration` all pass.
- Task committed and the F1-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
