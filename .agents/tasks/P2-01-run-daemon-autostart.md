# P2-01 — `tlbx run` daemon auto-start and readiness

**Milestone**: Phase 2 — CLI Tool Execution
**SPECS references**: §5.1, §5.3, §5.6 (criteria 1, 2, 9)

## Goal

Make `tlbx run` daemon-backed: it reuses a running ToolBox daemon for the current config, or starts one automatically when none exists.

## Deliverables

- A reusable daemon client helper in `apps/cli` or `@toolbox/core` that:
  - resolves the effective config path,
  - checks the config-specific serve-daemon state file,
  - clears stale state,
  - starts `tlbx serve --detach --http` when needed,
  - waits until the daemon's local HTTP endpoint is ready,
  - returns the daemon URL and lifecycle metadata to callers.
- Readiness polling with a bounded timeout and a clear failure message that points to the daemon log path and `tlbx doctor`.
- Config isolation: `tlbx run --config <path>` only reuses a daemon started for that same resolved config path.
- No idle timeout. Auto-started daemons stay running until `tlbx stop`.

## Acceptance criteria

- With no daemon running, the helper starts one and returns a ready local HTTP endpoint.
- With a daemon already running for the same config, the helper reuses it and does not spawn a second process.
- A stale state file is removed and replaced by a fresh daemon state.
- A daemon for a different resolved config path is not reused.
- Readiness timeout exits nonzero and includes the daemon log path.

## Out of scope

- The `tlbx run` command parser and tool-call logic (P2-02).
- Daemon idle shutdown.
- Remote daemon execution.

## Definition of done

- Acceptance criteria hold.
- Unit tests cover reuse, stale state cleanup, config isolation, spawn args, and readiness timeout.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
