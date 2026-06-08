# P3-09 — Route gateway/daemon OAuth refresh through the credential lock

**Milestone**: Phase 3 — cross-cutting (auth subsystem)
**SPECS references**: §4.6.2 (auth/token atomicity)

## Goal

Make the long-lived gateway/daemon's lazy OAuth token refresh acquire the same
per-server-name credential lock the CLI commands use (P3-08), so a running
gateway cannot race `tlbx auth logout` (or any other credential command) and
resurrect or clobber a token under the same key.

## Background

P3-08 added `withCredentialLock` and routed every CLI token-store writer
(`server add-http` OAuth, `auth login | logout | refresh`, `doctor --fix`)
through it, serializing same-name mutations across those commands.

The gateway is a separate process. When an upstream call finds an expired token,
the SDK-driven refresh writes the new token directly via the OAuth provider's
`saveTokens` (`packages/core/src/auth/oauth-provider.ts`) and the gateway runtime
(`packages/mcp-gateway/src/runtime/runtime.ts`), **without** acquiring the
credential lock. Because `withCredentialLock` is file-based and cross-process,
the gateway could participate in the same serialization — but it does not yet.

As a result, a gateway refresh that lands between a concurrent
`tlbx auth logout <name>` read and delete (or just after it) can write a fresh
token for a server the user just logged out, resurrecting the credential.

## Deliverables

- The gateway's token-refresh write path acquires the per-server-name credential
  lock for the duration of its read-modify-write, e.g. by wrapping the token
  store the OAuth provider persists through, or by threading a lock-aware
  persistence callback into the provider.
- The lock root must resolve to the same domain the CLI uses for the same
  server, so CLI and gateway contend on one lock (see also [[P3-10-credential-lock-domain]]).

## Acceptance criteria

- A concurrent gateway refresh and `tlbx auth logout <name>` cannot leave a token
  resurrected after logout: either the refresh completes before logout (then
  logout deletes it) or logout completes first (then the refresh, finding no
  usable session, does not silently re-create a record the user removed) — never
  a logged-out server with a freshly-written token.
- Normal proxied calls for other servers are not blocked by an in-progress
  refresh for one server.

## Out of scope

- Multi-host / networked locking.
- Changing the on-disk token-store format.

## Definition of done

- Acceptance criteria hold, with a test exercising a concurrent gateway-refresh
  vs. logout race.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` pass.
- Task committed and a P3-09 entry recorded in `.agents/TASKS.md`.
