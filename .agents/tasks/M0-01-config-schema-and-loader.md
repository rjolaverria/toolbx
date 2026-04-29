# M0-01 — Config schema, loader, and validator

**Milestone**: 0 — Skeleton
**Status**: Not started
**README references**: §2.1, §2.2, §4.4, §7 (Milestone 0)

## Goal

Define the Toolbox global config file format with Zod, and implement load / save / validate helpers in `@toolbox/core`. This is the IO boundary the rest of the system will sit behind.

## Deliverables

- `packages/core/src/config/schema.ts` — Zod schemas for the full config file (server, progressiveDisclosure, namespacing, servers map). Servers are a discriminated union on `type: 'stdio' | 'http'`.
- `packages/core/src/config/paths.ts` — resolves the active config path with this precedence:
  1. `TOOLBOX_CONFIG` env var
  2. `$XDG_CONFIG_HOME/toolbox/config.json`
  3. `~/.config/toolbox/config.json` (macOS / Linux)
  4. `%APPDATA%\Toolbox\config.json` (Windows)
- `packages/core/src/config/load.ts` — reads + parses + validates the config, returning a typed object. Throws a descriptive error on validation failures.
- `packages/core/src/config/save.ts` — writes config back to disk atomically (temp file + rename), preserving the `$schema` field.
- `packages/core/src/config/defaults.ts` — exports the default config object used by `tlbx init`.
- Public exports through `packages/core/src/index.ts`.

## Acceptance criteria

- The schema validates the example config from README §4.4 without modification.
- Validation rejects: duplicate server names (handled by the JSON object key uniqueness — but verify), unknown server `type`, invalid URLs for `http` servers, missing `command` for `stdio` servers, namespace separator other than `__` unless explicitly configured, and unknown top-level keys.
- `load.ts` returns the same TypeScript type that the rest of the codebase imports — no re-validation downstream.
- `paths.ts` resolves correctly on Linux, macOS, and Windows; tests cover all four precedence rules.
- Save is atomic: a crash mid-write must not leave a half-written config.

## Out of scope

- Migration between config versions (defer until version 2 exists).
- Schema URL hosting at `https://toolbox.dev/schema/config.schema.json` — leave as a string.

## Definition of done

- All acceptance criteria above hold.
- Vitest tests cover the schema, path resolver, and load/save round-trip.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task is committed on its own branch and the M0-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
