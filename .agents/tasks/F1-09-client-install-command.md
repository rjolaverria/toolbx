# F1-09 — Codex + OpenCode adapters and `tlbx client install` command

**Milestone**: Phase 1 follow-up (first-run DX overhaul)
**SPECS references**: §4.2 (new command), §4.3
**Depends on**: F1-08 (ClientAdapter framework)

## Goal

Add the remaining two adapters — Codex and OpenCode — and a new `tlbx client install <client>` CLI command that drives any single adapter end-to-end. After this task lands, a developer can replace the entire "copy snippet, find client config file, paste in right spot" dance with one command per client.

## Motivation

`tlbx client print-config` shipped in M5-01 as the M5 onboarding flow but stops short of actually wiring the client: the user still has to find the config file, paste the snippet in the right spot, and not break the surrounding JSON/TOML. The F1-08 framework gives us a clean primitive for doing the wiring; this task exposes it as a CLI command and ships the two file-edit adapters that need it most (Claude Code is already covered by F1-08).

## Deliverables

- **`packages/core/src/clients/codex.ts`** — Codex adapter:
  - Config path: `~/.codex/config.toml` (no Windows-specific path; Codex is POSIX-only today — call out clearly if Windows support is requested).
  - `detect()` returns `{ configPath }` iff the file exists.
  - `install()` follows the F1-08 contract: read, parse TOML, merge `[mcp_servers.toolbox]` block (`command = "npx"`, `args = ["-y", "tlbx", "serve", "--stdio"]`), idempotency check, conflict check with `force` semantics, atomic write via `<file>.tmp.<pid>` + rename, backup to `<file>.bak.<ISO>`, mtime-based concurrent-write detection.
  - Reuse whichever TOML library `apps/cli/src/commands/client-print-config.ts` already imports for the Codex branch (around line 95+). Do not add a new dep.

- **`packages/core/src/clients/opencode.ts`** — OpenCode adapter:
  - Confirm the config path against OpenCode's current docs before coding (CLAUDE.md library-docs rule applies). The merge shape must match exactly what the existing `client print-config opencode` branch in `apps/cli/src/commands/client-print-config.ts` emits today — read that branch first and have the adapter produce the same on-disk result. Do **not** model the OpenCode adapter on the Codex branch; OpenCode uses a different config format.
  - Same install contract as the other two adapters.

- **`packages/core/src/clients/index.ts`** — re-exports `claudeAdapter`, `codexAdapter`, `opencodeAdapter`, `detectClients`, and the public types from F1-08.

- **`apps/cli/src/commands/client-install.ts`** — new command `tlbx client install <client>`:
  - Positional `<client>`: one of `claude`, `codex`, `opencode`. Unknown values exit non-zero with the supported list (mirror `client print-config`).
  - Flags:
    - `-y, --yes` — skip the confirm prompt.
    - `--dry-run` — print the diff and exit 0 without writing.
    - `--force` — overwrite an existing conflicting `toolbox` entry. Still backs up.
    - `--config <path>` — override the ToolBox config path (unused by the adapter itself but accepted for parity with sibling commands).
  - Flow: call `adapter.detect()`. If null, exit non-zero with the adapter's standard "not detected" message and the path it looked at. Otherwise call `adapter.install({ dryRun: !confirmed, force })` twice — once with `dryRun: true` to compute the diff, present it, and prompt — then again with `dryRun: false` if the user confirms (or `--yes` was passed). On success print the configPath, the backup path, and a one-line "restart <client> to pick up the change". On `ok: false` print the reason + hint and exit non-zero.
  - Register under the existing `client` command group in `apps/cli/src/index.ts` next to `client print-config`.

- **Tests:**
  - `packages/core/src/clients/codex.test.ts` and `opencode.test.ts` — mirror the F1-08 test matrix (empty / unrelated entries / matching idempotent / conflicting / malformed / concurrent-mod / dry-run).
  - `apps/cli/src/commands/client-install.test.ts` — drive the command with each adapter mocked; assert exit codes, exact stdout for success/conflict/dry-run, and that `--force` is forwarded to the adapter.

## Acceptance criteria

- `tlbx client install claude` on a fresh machine with `~/.claude.json = {}` writes the `mcpServers.toolbox` entry, creates one backup, and exits 0.
- Re-running with no change prints "already wired into Claude Code" and exits 0.
- `tlbx client install claude --dry-run` prints the diff and exits 0 without writing anything.
- `tlbx client install codex` with a `~/.codex/config.toml` containing other unrelated `[mcp_servers.*]` blocks merges in `[mcp_servers.toolbox]` without disturbing the other blocks; the resulting TOML round-trips through the parser.
- `tlbx client install <unknown>` exits non-zero with the supported-clients list.
- All adapter unit tests and the CLI command tests pass.

## Out of scope

- `tlbx setup` (F1-10).
- Project-scope MCP registration.
- A `tlbx client uninstall <client>` command — defer until requested.
- Changes to `client print-config` (F1-11).
- A `--all` shortcut to install every detected client at once. The orchestrator (`setup`) is the right place for the "all detected" flow; the standalone command stays single-target.

## Definition of done

- Acceptance criteria hold.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` all pass.
- Coverage floors raised where the new tests improve the captured percentage.
- Pre-commit hook ran clean; the `F1-09` checkbox in `.agents/TASKS.md` is flipped with the closing commit / PR.
