# P3-11 — Investigate rare steal-path mutual-exclusion flake under load

**Milestone**: Phase 3 — cross-cutting (config-lock subsystem)
**SPECS references**: §4.6.2 (concurrency-safe persistence)

## Goal

Determine whether `withConfigLock` can, under heavy concurrent contention, admit
two critical sections at once while many waiters race to steal one stale lock —
and make the behavior (and its test) deterministic.

## Background

The P3-07 lock test
`packages/core/src/config/__tests__/lock.test.ts > withConfigLock > "preserves
mutual exclusion while many waiters race to steal one stale lock"` fires 8
concurrent acquisitions against a planted dead-pid stale lock and asserts
`maxActive === 1`. The `active` counter is incremented/decremented only inside the
locked function body, so an observed `maxActive === 2` means two bodies ran
concurrently — a genuine mutual-exclusion violation, not a timing artifact.

The test is green locally (0/15 stress runs and under the full `pnpm coverage`
run) but failed once on CI under load (`expected 2 to be 1`), then passed on
re-run. It surfaced during P3-08, whose added concurrency test files increase the
parallel filesystem/timer load the suite places on a CI runner.

## Hypotheses to check

- A real race in the steal protocol (`stealStale` / `acquireStealMutex` /
  `discardLockDir`) under contention — e.g. two stealers admitted, or a
  rename-aside window where two acquirers both publish.
- A filesystem-semantics assumption (atomic `rename` onto an existing/empty dir,
  `mkdir` exclusivity) that does not hold on the CI runner's filesystem
  (overlayfs/tmpfs) the way it does locally.
- Test brittleness only (the 3ms hold / 3ms poll is aggressive) — in which case
  stabilize the test without weakening the invariant it checks.

## Deliverables

- A root-cause determination (real race vs. environment vs. test brittleness).
- If a real race: a fix to the steal/publish protocol with a test that reproduces
  the violation deterministically (e.g. injected scheduling hooks) before the fix.
- If environment/brittleness: a hardened, deterministic test that still asserts
  strict mutual exclusion.

## Acceptance criteria

- The steal-contention exclusion test is deterministic (no observed
  `maxActive > 1`) across repeated CI and local runs.
- If a protocol fix is made, a regression test reproduces the prior violation.

## Out of scope

- Multi-host / networked locking.

## Definition of done

- Acceptance criteria hold.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` pass.
- Task committed and a P3-11 entry recorded in `.agents/TASKS.md`.
