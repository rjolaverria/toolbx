# P2-06 — `tlbx run` daemon-backed integration tests

**Milestone**: Phase 2 — CLI Tool Execution
**SPECS references**: §5.3, §5.6 (criteria 1, 2, 10)

## Goal

Verify `tlbx run` end to end against real daemon-backed upstream fixtures.

## Deliverables

- CLI integration tests that invoke the built `tlbx` binary, not just command functions.
- Stdio upstream fixture coverage:
  - no daemon running → `tlbx run` auto-starts daemon,
  - tool call succeeds,
  - second call reuses daemon,
  - two concurrent cold-start `tlbx run` calls converge on one daemon (no orphan, no error),
  - a config with `server.http.enabled=false` still runs (daemon forces loopback HTTP),
  - a same-port different-config daemon is not reused and reports a clear collision,
  - `tlbx stop` stops it.
- HTTP upstream fixture coverage:
  - daemon-backed call succeeds,
  - timeout/error path is surfaced correctly.
- Discovery integration coverage for `--list`, `--search`, `--describe`, `--schema`, and `--example`.
- Test isolation for config path, daemon state path, ports, logs, and environment variables.

## Acceptance criteria

- Integration tests pass from a clean checkout without requiring a pre-running daemon.
- Tests prove the same daemon PID is reused across repeated `tlbx run` calls for one config.
- Tests prove two concurrent cold-start calls for one config produce exactly one daemon PID.
- Tests prove a different config path on a different configured endpoint gets a different daemon.
- Tests prove a different config path on the same configured endpoint is rejected clearly rather than reused.
- Integration suite cleans up daemon processes even on failure.

## Out of scope

- Load testing.
- Remote daemon execution.
- Custom local tools before Phase 3 exposes them through the gateway and `tlbx run`.

## Definition of done

- Acceptance criteria hold.
- `pnpm test:integration` covers the new cases and remains stable.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run`, and `pnpm test:integration` all pass.
- Task committed and the P2-06 checkbox in `.agents/TASKS.md` is updated with the closing commit hash. After this lands, mark Phase 2 (§5.6 acceptance criteria 1–10) as complete in `.agents/TASKS.md`.
