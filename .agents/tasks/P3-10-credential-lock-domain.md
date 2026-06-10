# P3-10 — Align the credential-lock domain with the token-store key namespace

**Milestone**: Phase 3 — cross-cutting (auth subsystem)
**SPECS references**: §4.6.2 (auth/token atomicity)

## Goal

Make the per-server-name credential lock (P3-08) share one domain with the
token-store record it protects, so two commands that mutate the _same_ stored
credential always serialize — even when they run against different config-file
paths.

## Background

P3-08's `withCredentialLock(configDir, serverName, …)` anchors the lock under the
**config directory** of the invocation (`path.dirname(target)`). The only token
backend today is the keychain (`packages/core/src/auth/keychain-token-store.ts`),
which uses a fixed global service name (`dev.toolbox.cli`) and an account keyed
only by `serverName`. That record is therefore **machine-global**, independent of
which config file was used.

Mismatch: two invocations pointing at different config files via `-c` /
`TOOLBOX_CONFIG` (e.g. `-c prod.json` and `-c staging.json`) that both touch the
same `serverName` lock under _different_ config dirs but mutate the _same_
keychain record — so they are not serialized against each other. The realistic
single-config path is fully serialized; this gap only appears across distinct
config dirs sharing one keychain namespace.

## Options to evaluate

1. **Machine-global lock anchor for global backends** — resolve the keychain
   credential-lock root to a fixed, environment-independent location (matching
   the keychain's own global namespace) rather than the per-invocation config
   dir. Must keep test isolation (tests run against temp dirs) via a dependency
   seam, and must define a sane location on POSIX and Windows.
2. **Config-scoped token-store keys** — make keychain accounts incorporate a
   config/profile identifier so distinct configs use distinct records, letting
   the config-dir-scoped lock domain match. (Note: this changes the on-disk
   token-store key format.)

Pick one; option 1 keeps the single shared credential namespace, option 2 gives
per-config isolation. Coordinate with [[P3-09-gateway-refresh-credential-lock]]
so the CLI and gateway resolve the same lock domain.

## Acceptance criteria

- Two concurrent credential commands that target the same stored credential
  serialize regardless of the config path they were invoked with.
- Test isolation is preserved (tests do not contend on or write into a shared
  real credential-lock location).

## Out of scope

- Multi-host / networked locking.

## Definition of done

- Acceptance criteria hold, with a test exercising the cross-config same-credential race.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` pass.
- Task committed and a P3-10 entry recorded in `.agents/TASKS.md`.
