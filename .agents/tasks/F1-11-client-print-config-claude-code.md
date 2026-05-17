# F1-11 — Drop Claude Desktop from `client print-config`; align `claude` keyword with Claude Code

**Milestone**: Phase 1 follow-up (first-run DX overhaul, cleanup)
**SPECS references**: §4.3

## Goal

Reframe `tlbx client print-config claude` so that `claude` unambiguously means **Claude Code** (the CLI tool). Drop the Claude Desktop snippet generator. The printed snippet now targets `~/.claude.json` (Claude Code's user-scope MCP config) — the same file `tlbx client install claude` writes to in F1-09.

## Motivation

Phase 1 prioritized Claude Desktop because that's what `client print-config claude` emits today. The DX work in F1-08..F1-10 prioritizes Claude Code instead. Leaving `print-config claude` pointed at Desktop would diverge from `client install claude`, confuse new users, and force us to maintain two Claude Desktop code paths that nobody actively uses. Dropping it is cleaner than aliasing.

## Deliverables

- **`apps/cli/src/commands/client-print-config.ts`**:
  - Replace the existing Claude Desktop branch (around line 67+) with a Claude Code branch. The default (no `--json`) output prints a friendly two-paragraph explanation:
    1. Point the user at `~/.claude.json` (POSIX) or `%USERPROFILE%\.claude.json` (Windows).
    2. Tell them to merge the printed JSON block into the file's top-level `mcpServers` object. Also tell them that `tlbx client install claude` does this for them automatically with a backup.
  - The JSON block printed matches F1-08's merge contract exactly: `{ "mcpServers": { "toolbox": { "type": "stdio", "command": "npx", "args": ["-y", "tlbx", "serve", "--stdio"], "env": {} } } }`.
  - `--json` output is just the snippet JSON, no prose.
  - Codex and OpenCode branches are unchanged.

- **Tests**:
  - Update / replace the `client print-config claude` snapshot to reflect the new content. Keep coverage of both the prose and `--json` forms.
  - Remove tests asserting Claude Desktop config paths (e.g. `claude_desktop_config.json`).

- **Help text** (`tlbx client print-config --help`): list supported clients as `claude` (Claude Code), `codex`, `opencode`, `generic`. Make sure the help text matches the post-F1-09 `client install` help text so the two commands feel like siblings.

## Acceptance criteria

- `tlbx client print-config claude` mentions `~/.claude.json` and `mcpServers`. It must not mention `claude_desktop_config.json`.
- `tlbx client print-config claude --json` outputs JSON that `JSON.parse` accepts and that contains exactly `mcpServers.toolbox` with `type`/`command`/`args`/`env` fields.
- The snippet printed by `print-config claude` matches the entry written by `tlbx client install claude` byte-for-byte at the `toolbox` value.
- The `claude` keyword in `client print-config` no longer produces any Claude Desktop output anywhere in the codebase.

## Out of scope

- A Claude Desktop adapter / snippet generator. If a future user asks, it can come back as `claude-desktop` (separate keyword) in a new task.
- Changes to the upstream-server flow.
- Renaming any command.

## Definition of done

- Acceptance criteria hold.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` all pass; snapshots updated.
- README references reviewed — anywhere the old "Desktop config path" text appears, replace with the new Claude Code text.
- Pre-commit hook ran clean; the `F1-11` checkbox in `.agents/TASKS.md` is flipped with the closing commit / PR.
