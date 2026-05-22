# F1-24 — Persist and replay the OAuth resource indicator on refresh

**Milestone**: Phase 1 follow-up (OAuth upstream auth, RFC 8707 correctness)
**SPECS references**: §4.6.2 (re-auth/refresh flow)
**Depends on**: F1-13 (StoredOAuthRecord schema), F1-17 (OAuthClientProvider), F1-18 (runOAuthLogin), F1-19 (runOAuthRefresh)

## Goal

Make `tlbx auth refresh` (and any gateway-side lazy refresh) send the same RFC 8707 `resource` indicator that the original login used, so resource-bound OAuth servers accept the refreshed grant and issue a token for the correct audience.

## Motivation

A roborev review of F1-19 (job 82) found that `runOAuthRefresh` calls the SDK `refreshAuthorization` helper without a `resource` argument. When login discovers RFC 9728 protected-resource metadata, the SDK includes a `resource` (RFC 8707 Resource Indicator) in its token requests. If the refresh request omits it, a resource-bound authorization server may reject the refresh or return an access token scoped to the wrong audience.

This was deliberately scoped **out** of F1-19 because a correct fix is not a CLI-layer change:

- `StoredOAuthRecord` (F1-13) has no field for the selected resource. Unconditionally passing `serverUrl` as the resource on refresh would be wrong — it would add an indicator to servers that did **not** use one at login, potentially breaking them. The flag of "was a resource used, and which" must be persisted from login.
- Capturing the selected resource requires touching the F1-17 provider / F1-18 login path (the SDK computes it internally via `selectResourceURL` and does not currently hand it to the provider).

F1-19's refresh is correct for the common case (servers that did not use a resource indicator at login); this task closes the gap for resource-bound servers.

## Deliverables

- **`packages/core/src/auth/token-store.ts`** — extend `StoredOAuthRecordSchema` with an optional `resource` (string URL). Bump `schemaVersion` and handle migration/forward-compat for records written by F1-13..F1-19 (no `resource` field → treat as "no resource indicator").

- **`packages/core/src/auth/oauth-provider.ts`** / **`oauth-login.ts`** — capture the resource the SDK selected during login (e.g. via `selectResourceURL` or by recording it from discovery state) and persist it into the record at `saveTokens` time.

- **`packages/core/src/auth/oauth-refresh.ts`** — when the stored record carries a `resource`, pass it through to `refreshAuthorization`. When it does not, send no resource indicator (current behavior).

- **Tests**:
  - Core: a fake-auth-server variant that **requires** `resource` on the refresh grant (rejects refresh without it). Prove refresh succeeds when the record carries a resource and that the value round-trips from login.
  - Core: a record with no `resource` still refreshes (no indicator sent) — guards against regressing the non-resource-bound path.

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- `refreshAuthorization` receives the same `resource` value that login used, and only when login used one.
- Records written before this task (no `resource` field) still load and refresh.

## Out of scope

- Gateway runtime refresh wiring beyond passing the persisted resource — that lands with F1-21.

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
