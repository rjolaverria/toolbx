# F1-22 — `tlbx doctor` OAuth drift check + `--fix`

**Milestone**: Phase 1 follow-up (OAuth upstream auth, diagnostics)
**SPECS references**: §4.6.2 (atomicity + `tlbx doctor --fix` for orphan tokens)
**Depends on**: F1-13

## Goal

Extend `tlbx doctor` with two new checks: token-store availability and config/token drift. `--fix` cleans up orphan tokens automatically; orphan config entries (server entry exists, token doesn't) are reported but not auto-deleted (server entries are user content).

## Motivation

SPECS §4.6.2 commits to atomic add-http and atomic login, but bugs and Ctrl-C timing can still create drift. `doctor` is the canonical place to detect this and offer a fix. The check also doubles as the user-facing diagnostic when the keychain is broken (e.g. headless Linux missing libsecret) — same code path either way.

## Deliverables

- **`apps/cli/src/commands/doctor.ts`** (modify; the existing file from F1-03 / M5-05):

  Add a new `Auth` check section to the doctor output. The check runs whenever the config has at least one server with `auth.type === 'oauth'`, or whenever the token store has any entries.

  Behavior:
  1. **Token store health:**
     - Call `tokenStore.probe()`.
     - If `unavailable`: print a red row with the reason and a remediation hint (per platform: "macOS Keychain access denied — try running `tlbx auth login <server>` and approving the prompt", "Linux: install gnome-keyring or kwallet and start the secret service", etc.). Suppress the drift check below since `list()` would return [].
     - If `ready`: continue.

  2. **Drift detection:**
     - `configOAuthServers = config.servers entries with auth.type === 'oauth'`
     - `storedServers = await tokenStore.list()`
     - For each name in `storedServers` not in `configOAuthServers`: emit a yellow row, "orphan token for `<name>` — server entry not in config".
     - For each name in `configOAuthServers` not in `storedServers`: emit a yellow row, "missing token for `<name>` — run `tlbx auth login <name>`".

  3. **`--fix` behavior:**
     - Orphan tokens (in store, not in config): `tokenStore.delete(name)`. Safe — the user can always re-login.
     - Missing tokens (in config, not in store): **do not auto-fix.** Print a one-liner saying the user must run `tlbx auth login <name>` themselves. (Reasoning: silently triggering a browser flow from `doctor --fix` would violate the "browser only opens from explicit user action" principle in §4.6.2.)

  Match the existing doctor output style (color, table layout). The existing doctor command likely already has a section-based structure; add a new "Auth" section after the existing ones.

- **`apps/cli/src/commands/__tests__/doctor.test.ts`** (modify, or new test file for the new section):
  - **Ready token store, no drift:** check passes, green output.
  - **Unavailable token store:** prints unavailability row with the reason; drift rows suppressed.
  - **Orphan token (in store, not in config):** prints yellow row; `--fix` deletes it; second run shows no drift.
  - **Missing token (config has oauth, store doesn't):** prints yellow row with the `tlbx auth login` hint; `--fix` does **not** delete the config entry; second run still shows the row.
  - **Config has no OAuth servers and store is empty:** the Auth section either prints "no OAuth credentials configured" or is omitted entirely (pick one consistent with the existing doctor style and document the choice in a comment).

- **`apps/cli/src/commands/__tests__/__fixtures__/`** — reuse the test harness from existing doctor tests; the new tests need a token-store stub (`InMemoryTokenStore`) and a config-loader stub. No new fixture infrastructure required.

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- Doctor's Auth section is gated by "OAuth in config OR tokens in store" — never noisy for users who don't use OAuth.
- `--fix` only prunes orphan tokens; never deletes config entries; never opens a browser.
- Unavailable-token-store message is platform-specific where the underlying error reveals the platform (best-effort).

## Out of scope

- Diagnosing why a specific keychain backend is broken beyond the error message returned by `probe()`.
- Auto-running `tlbx auth login` from `doctor --fix`.

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
