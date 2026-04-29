# M0-03 — `tlbx init` command

**Milestone**: 0 — Skeleton
**README references**: §4.2, §4.4, §4.8 (criterion 1), §7 (Milestone 0)

## Goal

Implement `npx tlbx init` so users can bootstrap a fresh, valid Toolbox config file in the right location.

## Deliverables

- `apps/cli/src/commands/init.ts` registering an `init` subcommand on the Commander root.
- Resolves the target config path via `@toolbox/core` (`config/paths.ts` from M0-01).
- Creates parent directories as needed.
- Refuses to overwrite an existing config unless `--force` is passed.
- Writes the default config from `@toolbox/core` (`config/defaults.ts` from M0-01).
- Prints the absolute path of the created file plus a hint to run `tlbx serve`.
- Supports flags: `--force`, `--path <path>` (overrides resolution).

## Acceptance criteria

- `npx tlbx init` on a fresh machine creates a valid config at the expected default path and exits with status 0.
- A second `npx tlbx init` without `--force` exits with non-zero status, prints a message to stderr, and does not overwrite the existing file.
- `npx tlbx init --force` overwrites the existing config.
- The created file passes `pnpm tlbx config validate` (after M5-03 lands; until then, validate via `@toolbox/core` `load.ts` in tests).

## Out of scope

- Interactive prompts for adding servers during init.
- Migration from a legacy config layout.

## Definition of done

- Acceptance criteria above hold.
- Vitest tests run the command against a temp directory and assert the produced file structure.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M0-03 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
