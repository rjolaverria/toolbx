# M5-05 — `tlbx doctor` command

**Milestone**: 5 — Client Compatibility & UX Polish
**SPECS references**: §4.2, §7 (Milestone 5)

## Goal

A self-check command that diagnoses common problems without forcing the user to run `serve`.

## Deliverables

- `apps/cli/src/commands/doctor.ts` — `tlbx doctor`. Runs the following checks and prints PASS / WARN / FAIL per check, plus a summary footer.
  - Node.js version meets minimum (read from `engines.node` in `apps/cli/package.json`).
  - Config file exists and validates (`tlbx config validate`).
  - Each enabled server's `command` resolves on PATH (stdio) or `url` parses (http).
  - Each `${env:NAME}` placeholder used in the config has a value in the current environment.
  - Namespace collision check across enabled servers using their last-known tool registry snapshots if available.
  - Bind address sanity for `server.http` (Phase 1 must be loopback).
- Supports `--json` for machine-readable output and `--fix` (Phase 1 stub: fixes only what's safe — currently nothing automatic — but reports each fix decision).

## Acceptance criteria

- Exits 0 when every check is PASS or WARN; exits non-zero on any FAIL.
- Writes results to stdout in human-readable mode and stable JSON in `--json` mode.
- Each FAIL includes a one-line "how to fix" hint that names the right CLI command.

## Out of scope

- Auto-installing missing upstream MCP server packages.
- Actually mutating the system in `--fix` (defer until specific safe fixers exist).

## Definition of done

- Acceptance criteria hold.
- Tests cover at least one PASS, one WARN, and one FAIL fixture for each check class.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M5-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
