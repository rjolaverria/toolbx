# P3-08 — Per-server-name serialization of credential (token-store) mutations

**Milestone**: Phase 3 — cross-cutting (auth subsystem)
**SPECS references**: §4.6.2 (auth/token atomicity)

## Goal

Serialize all token-store mutations for a given server name across the commands
that touch credentials — `server add-http` (OAuth auto-trigger), `auth login`,
`auth logout`, `auth refresh` — so they cannot interleave on the same credential
key.

## Background

P3-07 made `config.json` and the custom-tool manifest concurrency-safe and added
a dedicated lock that serializes OAuth **registrations** (`add-http` vs
`add-http`) so a concurrent same-name OAuth add cannot clobber the winner's token
or config. That lock is scoped to the config/registration write path.

It does **not** coordinate `add-http` with the separate `auth` command family,
which mutate the **token store** (keychain / file) — a third store, distinct from
`config.json` and the manifest, and therefore outside P3-07's "config and
manifest persistence" scope. As a result, while an `add-http` OAuth flow is
between `runOAuthLogin` and its final config save/rollback, a concurrent
`tlbx auth logout <name>` can delete the token under the same key. Depending on
ordering, the add can then leave an OAuth server registered with no token, or its
rollback can restore a token the user just logged out.

## Deliverables

- A per-server-name credential lock (or an extension of the existing per-name
  serialization) acquired by every command that writes the token store for a
  server, held across the login/write/rollback critical section.
- Alternatively or additionally, make the OAuth rollback conditional on the
  stored record still being the one this command wrote (requires `runOAuthLogin`
  to surface the written record), so a rollback never reverts another command's
  change.

## Acceptance criteria

- Concurrent `add-http --auth oauth <name>` and `auth logout <name>` cannot leave
  an OAuth-configured server paired with the wrong/absent credentials: either the
  add wins (server + its token) or the logout wins (no server registered, or the
  add fails cleanly), never a torn mix.
- Credential operations for different names, and non-credential commands, are not
  blocked by an in-progress login.

## Out of scope

- Multi-host / networked locking.
- Changing the on-disk token-store format.

## Definition of done

- Acceptance criteria hold, with a test exercising a concurrent credential race.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` pass.
- Task committed and a P3-08 entry added to `.agents/TASKS.md`.
