# F1-19 — `tlbx auth login | logout | status | refresh` commands

**Milestone**: Phase 1 follow-up (OAuth upstream auth, CLI surface)
**SPECS references**: §4.2 (CLI commands), §4.6.2 (re-auth flow, exit codes)
**Depends on**: F1-14, F1-18 (F1-14 is required because the CLI instantiates the configured `TokenStore` via the factory — the default `keychain` backend would throw without F1-14's implementation)

## Goal

The user-facing CLI for OAuth credential management. Four subcommands under a new `auth` group, each doing one thing well, all using the same `runOAuthLogin` orchestrator and `TokenStore` interface.

## Motivation

SPECS §4.2 promotes these from "future" to first-class commands. Both end-users (who run `tlbx auth login` to recover from `auth_expired`) and the auto-trigger in F1-20 (`server add-http`) depend on the same underlying flow being available as a command.

## Deliverables

- **`apps/cli/src/commands/auth/index.ts`** — new file. Defines the `auth` Commander group and registers the four subcommands.

- **`apps/cli/src/commands/auth/login.ts`** — `tlbx auth login <server>`:

  ```ts
  // Sketch — match the existing command file style in apps/cli/src/commands/.
  // Arguments:
  //   <server>          required server name
  // Options:
  //   -c, --config <p>  config path override
  //   --timeout <ms>    callback timeout (default 5 min)
  //
  // Behavior:
  //   1. Load config. If servers[<server>] is missing → exit 1 with
  //      `Server "<server>" is not configured. Run \`tlbx server add-http ...\` first.`
  //   2. If servers[<server>].auth?.type !== 'oauth' → exit 1 with
  //      `Server "<server>" is not configured for OAuth (auth.type is "<actual>").`
  //   3. Resolve TokenStore via factory. Call probe(); if unavailable, exit 3
  //      with the reason. (`Token storage unavailable: <reason>. Run \`tlbx doctor\` for details.`)
  //   4. Install SIGINT handler that aborts an AbortController.
  //   5. Print `Opening browser to authenticate <server>…`
  //   6. Call `runOAuthLogin({ serverName, serverUrl, tokenStore, logger, abortSignal, forceReauth: true })`.
  //      `forceReauth: true` is the key difference from `add-http` — it makes
  //      the SDK do the full browser handshake even when a valid token is
  //      already stored, so the user can switch identities (§4.6.2).
  //   7. Branch on result:
  //      - success → print `✓ <server> authenticated. ToolBox will use the new token automatically.`,
  //                  exit 0.
  //      - cancelled → print the reason, exit 2.
  //      - failed → print the reason, exit 4.
  ```

- **`apps/cli/src/commands/auth/logout.ts`** — `tlbx auth logout <server>`:
  - Calls `tokenStore.delete(serverName)`.
  - Does **not** remove the server entry from `config.json` (logout ≠ remove).
  - Idempotent: deleting a nonexistent token succeeds with `✓ <server> logged out (no token was stored).`.
  - Exit 0 on success, 1 on generic error.

- **`apps/cli/src/commands/auth/status.ts`** — `tlbx auth status [server]`:
  - Without a server arg: list every `<serverName, has-token-yes/no, current-status>` row for OAuth-configured servers. Format as a table (reuse the existing table formatter the `status` command uses).
  - With a server arg: print details for that one server — auth type, presence of stored tokens, last `obtainedAt`, scopes, authorization server. Never print token values.
  - Exit 0 in both modes.

- **`apps/cli/src/commands/auth/refresh.ts`** — `tlbx auth refresh <server>`:
  - Loads `tokenStore.read(serverName)`. If missing → exit 1 with `No stored token for <server>. Run \`tlbx auth login <server>\`.`
  - Constructs a `ToolBoxOAuthProvider` and calls the SDK's refresh helper directly (no browser).
  - On success → print `✓ <server> token refreshed.`, exit 0.
  - On failure → print the underlying error, exit 4 (matches the discovery/network failure exit code; refresh is essentially a network call).

- **`apps/cli/src/index.ts`** (modified) — register the `auth` command group:

  ```ts
  program.addCommand(createAuthCommand());
  ```

  (Match the registration style used by `server`, `tools`, `config`, etc.)

- **Tests** under `apps/cli/src/commands/auth/__tests__/`:

  For each of the four commands, a snapshot test with:
  - A stubbed `runOAuthLogin` returning each `RunOAuthLoginResult` variant.
  - An `InMemoryTokenStore` pre-seeded with controlled state.
  - A mocked config loader returning a controlled config.

  Test cases (per command, abbreviated):
  - `login`: server-not-found → exit 1; non-oauth server → exit 1; success → exit 0 + stored token written; cancelled → exit 2 + no token written; failed → exit 4 + no token; storage unavailable → exit 3.
  - `logout`: missing token → exit 0 with no-op message; existing token → deleted from store, exit 0.
  - `status`: no servers → table empty; one server with token → row shows ✓; one without → row shows pending.
  - `refresh`: no token → exit 1; success → exit 0 + new `obtainedAt`; failure → exit 4.

  Snapshots capture both stdout/stderr text and exit code. Use `vi.spyOn(process, 'exit')` or wrap the command in a test harness that captures the would-be exit code.

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- All four commands appear in `tlbx auth --help`.
- Exit codes match SPECS §4.6.2 spec for `auth login` (0/1/2/3/4). Other commands use 0/1.
- No command prints token bytes anywhere in stdout/stderr (verified by snapshot review and the F1-23 CI grep gate).
- `auth login` honors `SIGINT` cleanly: callback server closes, no token written, exit code 2.

## Out of scope

- `add-http` integration that calls `runOAuthLogin` automatically — F1-20.
- Gateway runtime refresh — F1-21.
- Drift detection in `tlbx doctor` — F1-22.

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
