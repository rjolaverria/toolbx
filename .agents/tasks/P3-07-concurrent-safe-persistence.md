# P3-07 — Concurrency-safe config and manifest persistence

**Milestone**: Phase 3 — Custom JS/TS Tools (cross-cutting)
**SPECS references**: §6.6, §9 (design principle 7 — everything inspectable / predictable)

## Goal

Make every ToolBox mutation durable against concurrent writers, not just torn
writes. Today both `config.json` (via `@toolbox/core` `saveConfig`) and the
custom-tool manifest (via `@toolbox/custom-tools` `writeToolManifest` /
`commitImport`) write atomically (temp file + rename), so a reader never sees a
half-written file. Neither serializes the **read-modify-write** cycle: two
commands that run concurrently (e.g. `tlbx server enable` + `tlbx server
disable`, or `tlbx tool import` + `tlbx tool enable`) can each read the same
snapshot and write back the whole file, silently dropping the other's change.

This is a pre-existing, project-wide property of the config layer; the custom
tool manifest inherits the same model. It should be solved once, consistently,
for both stores — not bolted onto one file.

The same gap weakens the cross-store namespace-collision invariant (SPECS design
principle 4). `tlbx tool import` and `tlbx server add` each guard the collision
by reading the _other_ store, but with two unlocked files a concurrent writer
can still slip a colliding name/namespace in between the check and the write.
P3-04 narrows these windows by re-validating the opposite store immediately
before each final write (and rolling the OAuth token back on a late collision),
but only a shared lock closes them completely.

## Deliverables

- A shared mechanism for concurrency-safe updates of a JSON document, applied to
  both `config.json` and the tool manifest. Two viable shapes:
  - an advisory file lock (e.g. lockfile in the same directory, with stale-lock
    detection and bounded wait), or
  - an atomic compare-and-retry helper: read with a version/mtime token, apply
    the mutation, write only if the token is unchanged, retry on conflict.
- Route `saveConfig`-based command mutations and the manifest mutators
  (`setToolEnabled`, `removeTool`, `commitImport`) through it.
- Keep the existing atomic-write guarantee (no torn files) intact.
- Consolidate on a single hardened atomic writer. `@toolbox/custom-tools`'s
  `atomicWriteFile` relies on `rename`'s atomic replace and never unlinks the
  target; `@toolbox/core`'s `saveConfig` still has an `unlink`-then-`rename`
  fallback that briefly exposes a missing file. Reconcile both onto the
  rename-only writer.

## Acceptance criteria

- Two concurrent mutations of the same store do not lose an update: the final
  file reflects both changes (or the second cleanly retries against the first).
- The namespace-collision invariant holds under concurrency: a server name and a
  custom-tool namespace can never both end up registered for the same string.
- Cross-platform (macOS, Linux, Windows) — no reliance on POSIX-only flock
  semantics unless guarded.
- A stale lock (crashed process) does not deadlock subsequent commands.

## Out of scope

- Multi-host / networked locking (ToolBox config is local and single-user).
- Changing the on-disk JSON formats.

## Definition of done

- Acceptance criteria hold, with tests that exercise interleaved writers.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` pass.
- Task committed and the P3-07 checkbox in `.agents/TASKS.md` updated with the
  closing commit hash.
