# M1-06 — `tlbx server` management commands

**Milestone**: 1 — Upstream Connection Manager
**README references**: §4.2

## Goal

Round out the `server` subcommand surface so users can fully manage upstream servers from the CLI without editing the config by hand.

## Deliverables

- `apps/cli/src/commands/server-list.ts` — `tlbx server list`. Prints a table with name, type, enabled, configured URL/command, timeout. Supports `--json`.
- `apps/cli/src/commands/server-status.ts` — `tlbx server status <name>`. Connects (if not running) just long enough to read status, then prints the `ServerStatusEntry` from M1-04. Supports `--json`.
- `apps/cli/src/commands/server-toggle.ts` — `tlbx server enable <name>` and `tlbx server disable <name>`. Writes the change through the config save path; rejects unknown names.
- `apps/cli/src/commands/server-remove.ts` — `tlbx server remove <name>`. Confirms with a `--yes` flag (non-TTY requires `--yes`).
- `apps/cli/src/commands/server-edit.ts` — `tlbx server edit <name>`. Opens `$EDITOR` (or `vi` fallback) on a temp JSON file, validates on save, then atomically writes back. Aborts cleanly if validation fails.
- `apps/cli/src/commands/server-inspect.ts` — `tlbx server inspect <name>`. Prints the full config entry plus discovered tools, transport, and auth metadata.

## Acceptance criteria

- All commands fail clearly when given an unknown server name and never modify config in that case.
- `enable`/`disable` are no-ops when the state already matches and report this in human output.
- `edit` rejects invalid JSON and invalid schema, leaving the existing config untouched.
- `remove` without `--yes` in a non-TTY exits non-zero with a hint to pass `--yes`.
- `--json` output for `list`, `status`, `inspect` is stable enough to feed into other tools.

## Out of scope

- Auth login/logout (deferred to a later milestone).
- Renaming a server (would require namespace re-mapping; not in Phase 1).

## Definition of done

- Acceptance criteria hold.
- Unit tests exercise each command against a temp config file plus a mocked status registry.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M1-06 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
