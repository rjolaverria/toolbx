# M5-03 — `tlbx config` commands

**Milestone**: 5 — Client Compatibility & UX Polish
**SPECS references**: §4.2, §4.4, §4.8 (criterion 12)

## Goal

Inspect, edit, validate, and surgically modify the ToolBox config from the CLI.

## Deliverables

- `apps/cli/src/commands/config-path.ts` — `tlbx config path`. Prints the resolved config path (including which precedence rule won). Supports `--json`.
- `apps/cli/src/commands/config-edit.ts` — `tlbx config edit`. Opens `$EDITOR` on the config; validates after the editor exits and refuses to save invalid output. Aborts cleanly on editor non-zero exit.
- `apps/cli/src/commands/config-validate.ts` — `tlbx config validate`. Validates the config and reports each issue. Exits non-zero on invalid config. Catches: bad commands, duplicate names, invalid URLs, missing env vars, namespace collisions (per SPECS §4.8 criterion 12).
- `apps/cli/src/commands/config-set.ts` — `tlbx config set <path> <value>`. Path uses dot notation (e.g. `progressiveDisclosure.enabled`). Value is parsed as JSON. Re-validates the config before writing.

## Acceptance criteria

- `tlbx config validate` returns non-zero with a precise issue list for each of the five failure classes from SPECS §4.8 criterion 12.
- `tlbx config set progressiveDisclosure.enabled true` and `... false` both work and persist.
- `tlbx config set` rejects unknown paths and never produces an invalid config on disk.
- `tlbx config edit` falls back to `vi` when `$EDITOR` is unset (only on non-Windows).

## Out of scope

- Templating / env-var interpolation in `set` values (use plain JSON).
- Migrating across config schema versions.

## Definition of done

- Acceptance criteria hold.
- Tests cover each subcommand including the failure classes for `validate`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M5-03 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
