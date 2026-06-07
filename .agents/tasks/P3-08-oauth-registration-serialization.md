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

That leaves one residual, pre-existing edge: two `add-http --auth oauth`
commands for the **same** brand-new server name, run at the same time. Both pass
the pre-login duplicate check, both open a browser, and both write a token to the
same store key (the server name). The config write is then last-writer-wins, and
the token store holds whichever login finished last — so the registered config
and the stored credentials can disagree. P3-07 removed an over-eager token
rollback that made this worse (it could delete the winner's token), restoring the
prior last-writer-wins behaviour, but it did not make the path correct.

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
