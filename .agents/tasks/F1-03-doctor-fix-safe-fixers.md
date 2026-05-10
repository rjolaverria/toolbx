# F1-03 — `tlbx doctor --fix` safe fixers

**Milestone**: Phase 1 follow-ups
**SPECS references**: §4.2

## Goal

`tlbx doctor --fix` shipped in M5-05 as an explicit Phase 1 stub: the flag exists and reports per-check decisions but never mutates the system. M5-05 listed real fixers as out of scope. This task lands the first real safe fixers so `--fix` does something useful.

## Deliverables

- Implement at least the following fixers in `apps/cli/src/commands/doctor.ts`. Each one runs only when the corresponding check is FAIL, and only when the user has either passed `--yes` or has confirmed at the interactive prompt.
  - **Missing config directory**: create `~/.config/toolbox/` (respecting `XDG_CONFIG_HOME` / `TOOLBOX_CONFIG`) when the directory is absent. No-op when the path exists.
  - **Missing config file**: when the directory exists but `config.json` does not, write the same default config that `tlbx init` would write. Implementation must reuse `tlbx init`'s defaults — no second source of truth.
  - **Unset `${env:NAME}` placeholder**: print a copy-pasteable shell snippet (e.g. `export NAME=…`) to stdout. Do **not** mutate the user's shell rc files. This is a "guided fix," not an automated one.
- Each fixer must short-circuit cleanly in `--json` mode and report its action in the existing JSON shape.
- Each fixer must be idempotent: running `doctor --fix` twice in a row leaves the system in the same state as running it once.
- Document each fixer in the human-readable output as one of `APPLIED`, `SKIPPED (no fix available)`, or `SKIPPED (declined)`.

## Acceptance criteria

- On a fresh machine with no config dir, `tlbx doctor --fix --yes` creates the dir, writes a default config, and rerunning `tlbx doctor` reports PASS for both checks.
- On a config that references `${env:UNSET_VAR}`, `tlbx doctor --fix` prints a shell snippet and exits non-zero (the underlying check is still FAIL until the user runs the snippet).
- `tlbx doctor --fix --json` emits stable JSON with one entry per check, including a `fix` field describing the action taken.
- Tests cover each fixer's APPLIED, SKIPPED-no-fix, and SKIPPED-declined paths against a temp HOME/XDG fixture.

## Out of scope

- Auto-installing missing upstream MCP server packages (M5-05 already lists this as out of scope; that hasn't changed).
- Rewriting a malformed `config.json` automatically. Even if the defect is auto-resolvable (e.g. trailing comma), silently rewriting user-edited config is too risky for Phase 1.
- Fixers for HTTP bind-address violations — Phase 1 enforces loopback at the schema layer, so this can't fail.

## Definition of done

- Acceptance criteria hold.
- The M5-05 task file is updated with a one-line note pointing at this task as the deferral closure.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the F1-03 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
