# P2-01 — `tlbx run` daemon auto-start and readiness

**Milestone**: Phase 2 — CLI Tool Execution
**SPECS references**: §5.1, §5.3, §5.6 (criteria 1, 2, 9)

## Goal

Make `tlbx run` daemon-backed: it reuses a running ToolBox daemon for the current config, or starts one automatically when none exists.

## Deliverables

- A reusable daemon client helper in `apps/cli` or `@toolbox/core` that:
  - resolves the effective config path,
  - checks the config-specific serve-daemon state file,
  - clears stale state (a state file whose recorded pid is no longer alive),
  - probes the endpoint and reuses a healthy daemon for the same resolved config when one already answers,
  - starts a detached daemon when none is running,
  - waits until the daemon's local HTTP endpoint is ready,
  - returns the daemon URL and lifecycle metadata to callers.
- HTTP forced on regardless of `server.http.enabled` (§5.3): `tlbx run` needs an HTTP transport,
  so an auto-started daemon binds a loopback HTTP listener on the configured (or default)
  host/port even when `server.http.enabled` is `false`. This requires relaxing the
  `serve --detach` precondition that today rejects configs with HTTP disabled — gate it behind a
  run-spawn path (e.g. a force-http flag) so an explicit `tlbx serve --detach` still honors
  `server.http.enabled`.
- Concurrent cold-start handling that relies on the OS socket bind, without a separate lock file:
  - the OS listener bind is the mutual-exclusion primitive on the fixed loopback port;
  - the daemon binds its listener before publishing its state file, so a concurrent starter
    cannot see a half-started daemon and tear it down as a zombie;
  - a starter that loses the bind (port already in use) probes the endpoint and reuses the
    healthy ToolBox daemon, or fails clearly if the port is held by a foreign process.
- Readiness polling with a bounded timeout and a clear failure message that points to the daemon log path and `tlbx doctor`.
- Config isolation: `tlbx run --config <path>` only reuses a daemon started for that same resolved config path. If a daemon for another resolved config is healthy on the same host/port, the helper fails with a clear config/port collision message rather than reusing it. A separate daemon for another config is possible only when that config resolves to a different endpoint.
- No idle timeout. Auto-started daemons stay running until `tlbx stop`.

## Acceptance criteria

- With no daemon running, the helper starts one and returns a ready local HTTP endpoint.
- With a daemon already running for the same config, the helper reuses it and does not spawn a second process.
- A config with `server.http.enabled=false` still gets a working `tlbx run`: the auto-started daemon binds a loopback HTTP listener anyway.
- An explicit `tlbx serve --detach` (not via `tlbx run`) still rejects a config with HTTP disabled.
- Two concurrent cold-starts for the same config converge on exactly one daemon; the loser reuses it rather than erroring or orphaning a second process.
- A stale state file is removed and replaced by a fresh daemon state.
- A daemon for a different resolved config path is not reused; if it owns the same host/port, startup fails clearly, and if it uses a different endpoint, a distinct daemon can be started.
- Readiness timeout exits nonzero and includes the daemon log path.

## Out of scope

- The `tlbx run` command parser and tool-call logic (P2-02).
- Daemon idle shutdown.
- Remote daemon execution.

## Definition of done

- Acceptance criteria hold.
- Unit tests cover reuse, stale state cleanup, config isolation, same-port different-config collision, spawn args, forced-HTTP on an HTTP-disabled config, concurrent cold-start convergence, and readiness timeout.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
