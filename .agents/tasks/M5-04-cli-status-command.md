# M5-04 — `tlbx status` command

**Milestone**: 5 — Client Compatibility & UX Polish
**SPECS references**: §2.5, §4.2, §4.8 (criterion 11)

## Goal

A single command that shows what every configured upstream server is doing right now.

## Deliverables

- `apps/cli/src/commands/status.ts` — `tlbx status`.
  - Loads config, instantiates the status registry (M1-04), starts upstream sessions briefly, polls status, prints a table, then disposes.
  - Columns: name, type, enabled, status, auth, tool count, last connected, last error.
  - Supports `--json`, `--server <name>` (filter), `--no-connect` (read config only, do not start sessions).
  - Exits non-zero if any enabled server is in `error`, `auth_required`, or `auth_expired`.

## Acceptance criteria

- With one healthy stdio server, `tlbx status` shows `connected` and a tool count > 0.
- With a misconfigured server (bad command), it shows `error` and the exact stderr line.
- `--no-connect` runs without spawning upstream processes and reports `disabled` / `enabled` only.
- `--json` output is stable and snapshot-tested.

## Out of scope

- Streaming live status updates (Phase 2 UI).
- Forcing a reconnect (that's `tlbx server status <name>` territory in M1-06).

## Definition of done

- Acceptance criteria hold.
- Tests cover both connect and `--no-connect` paths against fixture servers.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M5-04 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
