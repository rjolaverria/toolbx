# P3-08 — Per-server-name serialization of OAuth registration

**Milestone**: Phase 3 — Custom JS/TS Tools (cross-cutting, auth subsystem)
**SPECS references**: §4.6.2 (auth atomicity)

## Goal

Serialize the full `tlbx server add-http` OAuth registration (browser login +
token write + config write) for a given server name, so two concurrent OAuth
registrations of the **same** new name cannot interleave.

## Background

P3-07 routes config and manifest writes through a shared config-dir
`withConfigLock`, closing lost-update and cross-store namespace-collision
windows. It deliberately does **not** hold that lock across the interactive
browser OAuth flow (doing so would block every other `tlbx` command for the
whole login, timing them out).

That leaves one residual edge: two `add-http --auth oauth` commands for the
**same** brand-new server name, run at the same time. Both pass the pre-login
duplicate check and both open a browser before either writes config. P3-07 made
this safe — under the config lock the loser now detects the duplicate after login
and fails without deleting the winner's token (its token-store key is the same
server name), at worst leaving a benign orphan token surfaced by `tlbx doctor`.
What remains is an **optimization/UX gap**, not a correctness gap: the loser
still completes a full browser login before discovering the name is taken, and a
non-OAuth winner can leave the loser's orphan token behind. Serializing OAuth
registration per server name before the browser flow would let the loser fail
fast and avoid the orphan entirely.

This is an auth-subsystem concern (not config/manifest persistence) and a
degenerate race (two simultaneous interactive logins for one identical new
name), so it is tracked separately rather than expanding P3-07.

## Deliverables

- Serialize OAuth registration per server name so only one OAuth `add-http` for a
  given name runs at a time, without blocking unrelated commands or other names.
  Options: a per-name advisory lock acquired before the pre-login duplicate
  check and held through the config write; or a transactional token write/rollback
  keyed to the exact record this command wrote.
- The losing command fails cleanly (name already registered) without touching the
  winner's token or config.

## Acceptance criteria

- Two concurrent `add-http --auth oauth` for the same new name: exactly one
  registers (config + matching token); the other fails with a "already exists"
  style error and leaves the winner's token and config intact.
- Registrations for **different** names, and non-OAuth commands, are not blocked
  by an in-progress OAuth login.

## Out of scope

- Multi-host locking.
- Changing the on-disk token-store format.

## Definition of done

- Acceptance criteria hold, with a test exercising the concurrent same-name
  OAuth race.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` pass.
- Task committed and a P3-08 entry added to `.agents/TASKS.md`.
