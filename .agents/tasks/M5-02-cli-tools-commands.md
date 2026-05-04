# M5-02 — `tlbx tools` commands

**Milestone**: 5 — Client Compatibility & UX Polish
**SPECS references**: §4.2

## Goal

Browse and gate the tool registry from the CLI without an MCP client.

## Deliverables

- `apps/cli/src/commands/tools-list.ts` — `tlbx tools list`. Prints exposed name, server, original tool name, enabled state. Supports `--json` and `--server <name>`.
- `apps/cli/src/commands/tools-search.ts` — `tlbx tools search <query>`. Reuses M4-01 search and prints the same table as `list`. Supports `--limit` and `--json`.
- `apps/cli/src/commands/tools-toggle.ts` — `tlbx tools enable <namespace/tool>` and `tlbx tools disable <namespace/tool>`.
  - Accepts both `namespace/tool` (per SPECS §4.2) and `namespace__tool` notation; rejects ambiguous input.
  - Writes a per-tool `enabled` override into config under `tools[exposedName].enabled`. (Add this field to the config schema in M0-01 if it does not yet exist; otherwise extend in this task.)

## Acceptance criteria

- `tlbx tools list` requires the gateway to have run at least once for the registry to be populated; if not, it prints a clear message instructing the user to run `tlbx serve` first or use `--from-config` to list only the configured surface.
- `tlbx tools search` ranking matches the M4-01 algorithm.
- Disabling a tool causes it to be excluded from `tools/list` (verified via integration test in M5-06).
- Enabling/disabling an unknown tool name exits non-zero and does not modify config.

## Out of scope

- Reveal/hide from the CLI (that's a per-MCP-session concept and belongs in the bootstrap tools).
- Bulk operations (could be added later).

## Definition of done

- Acceptance criteria hold.
- Tests cover each subcommand against a fixture registry / config.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M5-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
