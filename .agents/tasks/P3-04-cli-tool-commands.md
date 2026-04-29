# P3-04 — `tlbx tool` CLI commands

**Milestone**: Phase 3 — Custom JS/TS Tools
**README references**: §6.4

## Goal

The CLI surface for custom tools, mirroring `tlbx server` for upstream MCP servers.

## Deliverables

- `apps/cli/src/commands/tool-import.ts` — `tlbx tool import <path>`. Calls P3-02. Prints a permission preview and prompts for confirmation; supports `--yes` for non-interactive.
- `apps/cli/src/commands/tool-list.ts` — `tlbx tool list`. Lists imported tools with `name`, `namespace`, `exposedName`, `enabled`. Supports `--json`.
- `apps/cli/src/commands/tool-inspect.ts` — `tlbx tool inspect <exposedName>`. Prints the manifest plus a head of the source file.
- `apps/cli/src/commands/tool-toggle.ts` — `tlbx tool enable <exposedName>` / `tlbx tool disable <exposedName>`.
- `apps/cli/src/commands/tool-remove.ts` — `tlbx tool remove <exposedName>` with `--yes` for non-interactive. Removes the source file and the manifest entry.

## Acceptance criteria

- `tlbx tool import ./send_slack_summary.ts` produces the manifest + storage path described in README §6.2 / §6.3.
- `inspect` redacts env-var values; only declared `permissions.env` names are shown.
- Disabling a tool causes it to be omitted from `tools/list` (verified in P3-05 integration).

## Out of scope

- Re-importing as an update operation (Phase 1: remove + import).
- Importing from a URL (Phase 1: local files only).

## Definition of done

- Acceptance criteria hold.
- Tests cover each subcommand against a temp Toolbox config dir.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P3-04 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
