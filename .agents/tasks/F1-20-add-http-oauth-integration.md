# F1-20 — `server add-http` probe-and-trigger integration

**Milestone**: Phase 1 follow-up (OAuth upstream auth, add-http auto-flow)
**SPECS references**: §4.6.2 (auto-trigger at add-http time, atomicity)
**Depends on**: F1-15, F1-18

## Goal

Make `tlbx server add-http <name> --url <url>` (without an explicit `--auth` flag) probe the URL, branch on the result, and — for OAuth servers — run the full browser flow before writing the config entry. Explicit `--auth oauth | bearer | none` short-circuits the probe.

## Motivation

The brainstorm decided the canonical add-http UX is "one command, one outcome." The user types `add-http github --url …`, walks through the browser, and the server is ready. SPECS §4.6.2 also commits to atomicity: the config entry is only written after the OAuth flow completes.

## Deliverables

- **`apps/cli/src/commands/server-add.ts`** (modify):

  Update the command flow:

  ```text
  if --auth flag is set explicitly:
    follow the existing path for that auth type (none / bearer / oauth)
    for `--auth oauth`, run the F1-18 orchestrator before writing config
    for `--auth bearer`, require --token-env (existing behavior)
    for `--auth none`, write entry as-is (existing behavior)
  else (no flag — discovery mode):
    call probeUpstreamAuth(url)
    switch on AuthHint:
      'none'    -> write entry with auth: { type: 'none' }
                   print `✓ <name> registered (no auth required).`
      'oauth'   -> print `OAuth required for <name>. Opening browser to authenticate…`
                   call runOAuthLogin({ serverName, serverUrl, resourceMetadataUrl, … })
                   on success: write entry with auth: { type: 'oauth' }
                               print `✓ <name> registered (OAuth). N tools available.`
                   on cancelled: do not write entry; exit 2 with `Authentication cancelled. <name> was not registered.`
                   on failed: do not write entry; exit 4 with `Authentication failed: <reason>. <name> was not registered.`
      'bearer'  -> print explicit message and exit 1:
                   `Server <name> at <url> requires bearer auth.\n
                    Retry with: tlbx server add-http <name> --url <url> --auth bearer --token-env <YOUR_TOKEN_ENV>`
                   (do not auto-prompt for the env var name — keep the flow predictable)
      'unknown' -> print the response status and body excerpt; ask user to pick an --auth flag and retry; exit 4.
  ```

  Validate the server name with the existing `ServerNameSchema` (already exported per the F1-10 changes); reuse that validation, do not duplicate.

  After successful write, optionally call `tlbx server status <name>` programmatically to print the tool count — but only on the `none` and `oauth` paths where we expect a working connection. Match the message format from the existing `add-stdio` success path.

- **`apps/cli/src/commands/__tests__/server-add.test.ts`** (modify, existing file) — add tests for each new branch:
  - **Probe returns `none`** → existing-style behavior; entry written; no `runOAuthLogin` call.
  - **Probe returns `oauth`, success** → `runOAuthLogin` invoked with the resource-metadata URL; entry written with `auth: { type: 'oauth' }`; tokenStore has the record. Print includes "OAuth required" and "registered (OAuth)".
  - **Probe returns `oauth`, cancelled** → no config write; tokenStore unchanged; exit code 2.
  - **Probe returns `oauth`, failed** → no config write; tokenStore unchanged; exit code 4.
  - **Probe returns `bearer`** → no config write; printed message includes the suggested `--auth bearer --token-env` invocation; exit code 1.
  - **Probe returns `unknown` (500)** → no config write; printed message includes the 500 and body excerpt; exit code 4.
  - **Explicit `--auth oauth`** → probe skipped; `runOAuthLogin` invoked; same atomicity guarantees.
  - **Explicit `--auth bearer --token-env X`** → existing path; probe skipped.
  - **Explicit `--auth none`** → existing path; probe skipped.

  Atomicity property tests (one per failure branch): after the command exits non-zero, asserting both `config.servers[name]` is absent and `tokenStore.read(name)` is `null`.

- **Test fixtures** — reuse the F1-18 fake-oauth-server fixture (move it to a shared test fixtures path if needed) so this task's tests don't reinvent it.

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- Every branch of `AuthHint` is reachable in tests with the documented behavior.
- Atomicity: in every failure branch tested, **both** `config.json` and the token store are unchanged compared to the pre-command state.
- Existing `add-http --auth bearer --token-env X` callers see no behavior change.
- Explicit `--auth oauth` (without a URL probe) works against the F1-18 fixture.

## Out of scope

- Token storage backend selection — taken from `config.auth.storage` per F1-12/F1-13/F1-14.
- Status-table formatting beyond what already exists.
- Gateway integration — F1-21.

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
