# F1-04 — Vitest coverage thresholds

**Milestone**: Phase 1 follow-ups
**SPECS references**: none — closes a quality-gate gap.

## Goal

`pnpm coverage` produces a V8 report today, but nothing fails on regression. Set per-package floors based on current coverage so a future PR that drops coverage below the floor fails CI instead of silently degrading the suite.

## Depends on

- F1-01 (CI workflow). Thresholds without CI enforcement are decoration. Land F1-01 first.

## Deliverables

- Run `pnpm coverage` once on `main` immediately before authoring this task to capture the current per-package numbers (lines / statements / branches / functions). Record the numbers in the task PR description so reviewers can see what was used as the baseline.
- Per-package floors set via `coverage.thresholds` glob keys (`apps/cli/src/**`, `packages/core/src/**`, `packages/mcp-gateway/src/**`) in the **root** `vitest.config.ts`. Vitest treats `coverage` as a non-project option in workspace mode, so the per-package `vitest.config.ts` files cannot host their own coverage settings — the glob-keyed thresholds at the root achieve the same per-package floor. Set each metric to the floor of (current value − 2). The slack absorbs noise; a real regression of more than two points fails the gate.
- Update the CI workflow (from F1-01) to run `pnpm coverage` and surface the report as a job artifact. Coverage failure must fail the job.
- A short note in `CLAUDE.md` under "Tests" documenting the policy: thresholds are floors, not goals; raising them is encouraged, lowering them needs a justification in the PR description.

## Acceptance criteria

- A PR that deletes a test which was the sole coverer of a non-trivial branch fails the `coverage` job in CI.
- The thresholds in each package match the captured baseline (within the documented slack).
- `pnpm coverage` runs locally and in CI without additional flags.

## Out of scope

- Aspirational coverage targets. We're locking in current behavior, not setting a stretch goal.
- Coverage for integration tests (CLI integration suite is excluded from this measurement to keep the floors stable).
- Per-file thresholds. Per-package is enough for Phase 1.

## Definition of done

- Acceptance criteria hold.
- Baseline numbers are recorded in the closing commit / PR.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run`, and `pnpm coverage` all pass.
- Task committed and the F1-04 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
