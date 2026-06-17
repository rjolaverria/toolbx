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

## Resolution

**Determination: a real race in the steal protocol**, not test brittleness or a
filesystem-semantics deviation. The individual filesystem primitives the protocol
relies on all hold on Linux ext4, tmpfs, and overlayfs (verified directly:
`rename` onto a non-empty dir fails; concurrent `rename`/`mkdir`/`O_EXCL` publish
admit exactly one winner). The violation is a multi-step time-of-check/time-of-use
gap exposed by libuv's threadpool, which runs competing acquirers' fs syscalls
truly in parallel — invisible on the original macOS/APFS dev box but reproducible
~1–3% per round on Linux.

Captured trace (instrumented build, tmpfs): a stealer holding the steal mutex
re-confirms staleness at the instant the slot is momentarily empty (a holder had
just released, renaming its lock aside) — `evaluateStale` returned the
"gone" → `steal: true` verdict. A fresh live holder then publishes into the empty
slot, and the stealer's `discardLockDir` `rename(lockDir, …)` removes that live
lock, letting a second acquirer in (`maxActive === 2`).

**Root cause:** `stealStale` treated an _absent_ slot as stealable and called
`discardLockDir`, which renames whatever occupies `lockDir` at rename time. An
absent slot has no stable instance to remove; the next publisher fills it before
the rename lands.

**Fix:** the removal is matched to whether the re-confirmed slot is _replaceable_,
classified by a single `readdir` at evaluate time (so the structural read cannot
straddle a concurrent publish). Acquirers only ever place `meta.json` in `lockDir`,
so a non-empty dir _without_ `meta.json` is never a live holder. `evaluateStale`
therefore returns: rename-aside for any _non-empty_ slot (a dead/corrupt-meta lock
or a non-meta leftover) — a concurrent `rename` onto a non-empty dir fails, so the
observed instance is stable and the atomic rename-aside removes exactly it; and
`rmdir`-if-empty for an _empty_ (or absent) slot, which _is_ replaceable, so the
non-recursive `rmdir` removes it only while still empty and fails (`ENOTEMPTY`)
once a holder has published — it is never escalated to a rename-aside, since a slot
that turned non-empty may be a live holder. This closes the original absent-slot
race, the empty-stale-dir variant, the corrupt-meta and non-empty-leftover reclaim
regressions, and the release/reacquire race in the earlier `ENOTEMPTY` fallback
(all surfaced in code review).

**Tests:** deterministic regression tests drive `stealStale` through an
`afterReconfirm` seam — a live lock published into an absent slot and into an empty
stale slot are both left in place; a non-empty slot that fills in after an empty
re-confirm is left for the acquire loop (no escalation); and an aged corrupt-meta
lock and a non-empty meta-less leftover are both reclaimed. Each fails against the
corresponding pre-fix behaviour. Two sibling timing tests are deflaked to wait on
the actual condition. Verified with thousands of stress rounds across Linux tmpfs
and overlayfs under `UV_THREADPOOL_SIZE=8` (meta-bearing and empty plants) — zero
violations (the same configs violated 4–12% of rounds before the fix).
