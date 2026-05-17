# F1-10 — `tlbx setup` orchestrator and README rewrite

**Milestone**: Phase 1 follow-up (first-run DX overhaul, capstone task)
**SPECS references**: §4.2 (new command)
**Depends on**: F1-08, F1-09

## Goal

Collapse the four-step first-run flow into a single command. `npx tlbx setup` creates the config if missing, optionally takes one upstream server entry, detects every installed MCP client, and wires ToolBox into each — idempotently, with backups, atomic writes, and a diff preview the user confirms once. The README quickstart leads with this command.

## Motivation

The friction we're fixing is "I just heard about ToolBox, what do I run?". Today the answer is `init` → `server add-*` → `serve` → `client print-config` → paste-into-Claude-config-by-hand. After this task, the answer is `npx tlbx setup`. Defaulting to stdio transport means the MCP client itself spawns the gateway on demand — the user never types `tlbx serve` for the happy path.

## Deliverables

- **`apps/cli/src/commands/setup.ts`** — new top-level command `tlbx setup`. Flow:
  1. **Ensure config exists.** If `~/.config/toolbox/config.json` (or `--config` override) is missing, create it by calling the existing init logic from `apps/cli/src/commands/init.ts` (refactor that file to expose a `createConfigIfMissing(path)` helper if not already extracted). Print a one-line `✓ Created config at <path>`. If it already exists, say `✓ Config already exists at <path>` and continue.
  2. **Detect clients.** Call `detectClients()` from `@toolbox/core/clients` (F1-08). Print the detected list:
     ```
     Detected MCP clients:
       • Claude Code  (~/.claude.json)
       • Codex        (~/.codex/config.toml)
     ```
     If none are detected, skip to step 4 with a note.
  3. **Optional upstream server prompt.** Unless `--no-server` is passed, prompt:
     ```
     Add an upstream MCP server now? [Y/n]
       Name:    <input>
       Command: <input, will be split on whitespace>
       Env var (KEY=VALUE, blank to finish): <input>
       Env var: <enter>
     ```
     Validate the name with the same regex `server add-stdio` uses (alphanumeric + `-/_`, no `__`). On accept, write the entry via the same code path `server-add.ts` uses — do **not** duplicate validation. If `--yes` is passed without `--server "..."` shorthand, skip the prompt and tell the user how to add servers later.
  4. **Per-client install.** For each detected client (or just the one named by `--client <name>`), invoke the adapter from F1-09:
     - Compute the diff with `install({ dryRun: true, force: false })`.
     - Show the diff under the client header.
     - When at least one diff is non-empty, ask once: `Wire ToolBox into <list>? [Y/n]`. `--yes` skips the prompt.
     - On confirm, run `install({ dryRun: false, force: false })` per client. Print a green check per success, the reason + hint on failure. Don't abort the loop on one client's failure.
  5. **Summary.** Print:
     ```
     ✓ All set. Restart <list of wired clients> to pick up the new server.
     Add more upstream servers anytime:  tlbx server add-stdio <name> -- <cmd>
     ```
     Exit 0 if at least one step succeeded. Exit non-zero only if **every** step failed.

  Flags:
  - `-y, --yes` — skip all confirms.
  - `--client <name>` — scope client wiring to one client; can be repeated. Default: every detected client.
  - `--no-server` — skip the upstream-server prompt entirely.
  - `--transport http` — exit non-zero immediately: `"--transport http is not yet supported in v1. Use stdio (default) or run \`tlbx serve\` manually."`
  - `--config <path>` — pass through to underlying commands.

- **`apps/cli/src/index.ts`** — register `setup` as a top-level command (next to `init`, not under any group).

- **README rewrite** at `README.md`:
  - Quickstart section becomes:
    ```bash
    npx tlbx setup
    ```
    followed by a 2-3-sentence description and a screenshot-style code block showing typical output.
  - Move the current four-step flow into an "Advanced / scripting" subsection — still documented for CI and power users.
  - Update the existing `client print-config` example to reflect F1-11's Claude Code semantics if F1-11 has merged first; otherwise leave a `TODO(F1-11)` comment and resolve it in that task.

- **Integration test** at `apps/cli/src/commands/setup.test.ts`:
  - Set up a temp HOME with a fake `~/.claude.json = {}` and a fake `~/.codex/config.toml`.
  - Run `tlbx setup --yes --no-server`.
  - Assert: config created, both client files contain the `toolbox` entry, both have backup files, exit code 0.
  - Run again immediately; assert no second backup, "already wired" output, exit code 0.
  - Run with no detected clients; assert exit 0 with the "no clients" summary.

## Acceptance criteria

- On a clean machine with Claude Code (and only Claude Code) installed, `npx tlbx setup --yes` creates the config, adds the `toolbox` entry to `~/.claude.json` with a backup, prints the summary, exits 0.
- A second run prints "already wired" for Claude Code and does not produce a second backup file.
- `npx tlbx setup --transport http` exits non-zero with the unsupported message and does **not** modify any files.
- `npx tlbx setup --client codex` skips Claude Code even if both are installed.
- The README quickstart at HEAD is the single command `npx tlbx setup` followed by a brief description.

## Out of scope

- HTTP-as-OS-service installation (launchd / systemd). The `--transport http` flag is reserved but errors out.
- Auto-detection of project-scope `.mcp.json` files.
- Editing an already-running MCP client's in-memory state to pick up the change without a restart — the summary tells the user to restart.
- A `tlbx setup --remove` / uninstall path. Defer until requested.
- Changes to `client print-config` semantics (F1-11).

## Definition of done

- Acceptance criteria hold (verified manually for at least one client's install round-trip, not just by unit tests).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` all pass.
- Coverage floors raised where new tests improve the captured percentage.
- Pre-commit hook ran clean; the `F1-10` checkbox in `.agents/TASKS.md` is flipped with the closing commit / PR.
