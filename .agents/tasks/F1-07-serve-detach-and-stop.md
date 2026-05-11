# F1-07 — `tlbx serve --detach` and `tlbx stop`

**Milestone**: Phase 1 follow-up (user-requested enhancement)
**SPECS references**: §4.1, §4.2 (extends `tlbx serve`). Note: M2-06 explicitly listed "a persistent daemon / launchd / systemd integration" as out of scope. This task adds a lightweight, in-shell background mode — it is **not** an OS service integration (no launchd/systemd). It supersedes that part of the M2-06 deferral.

## Goal

Let users run the gateway in the background without it holding the terminal. `tlbx serve --detach` should fork a detached child running the normal HTTP gateway, return immediately, and record enough state for `tlbx stop` to shut it down later.

## Motivation

Today `tlbx serve` runs in the foreground and owns the terminal until killed. Users who want ToolBox available to their MCP clients while they keep working in the same shell have to background it manually (`nohup … &`, `disown`), manage the PID themselves, and find a place for the logs. A first-class `--detach` / `stop` pair removes that friction.

## Deliverables

- **Daemon state in `@toolbox/core`** — a small module (e.g. `packages/core/src/serve-daemon/`) that:
  - Resolves the state file and log file paths next to the resolved config path (mirroring `resolveToolCachePath`): `<config-dir>/serve-state.json` and `<config-dir>/serve.log` — e.g. `~/.config/toolbox/serve-state.json` and `~/.config/toolbox/serve.log` on POSIX, `%APPDATA%\ToolBox\serve-state.json` and `%APPDATA%\ToolBox\serve.log` on Windows. Honor `XDG_CONFIG_HOME` / `TOOLBOX_CONFIG` the same way the tool cache does, and place both files next to the config file when `--config` / `TOOLBOX_CONFIG` points at an explicit file.
  - Defines a Zod-validated `ServeDaemonState` shape: `{ pid, mode, url, logPath, startedAt }` (`mode` is `'http'` for now; `url` is the configured endpoint or `null`).
  - Provides `readServeState` (returns `null` on ENOENT or invalid file), `writeServeState`, `clearServeState`, and an `isProcessAlive(pid)` helper (`process.kill(pid, 0)` with ESRCH → false, EPERM → true).
  - Is re-exported from `@toolbox/core`'s public index.
- **`tlbx serve --detach` (`-d`)** in `apps/cli/src/commands/serve.ts` (plus a helper module if it keeps `serve.ts` tidy):
  - Mutually exclusive with `--stdio` (stdio mode needs the parent's stdio as its transport) — passing both exits non-zero with a descriptive error.
  - Loads and validates the config **in the parent first** (so config / `http.enabled` errors surface to the user before forking).
  - Refuses to start a second instance: if a state file exists and its PID is alive, print "already running (pid N)" with the log path and exit non-zero; if the PID is dead, treat the state file as stale and overwrite it.
  - Spawns `process.execPath` with the CLI entry script (`process.argv[1]`, injectable for tests) and the forwarded args (`serve --http`, plus `--config`, `--log-level`, `--log-format` if the user passed them — never `--detach`), `detached: true`, `stdio: ['ignore', logFd, logFd]` (log file opened in append mode), inheriting `process.env`, then `child.unref()`.
  - Writes the state file (`pid` from the child, `mode: 'http'`, `url` built from `config.server.http`, `logPath`, `startedAt`).
  - Briefly waits (a short, injectable delay) and re-checks the child is alive; if it died immediately, clear the state file, point the user at the log, and exit non-zero.
  - On success prints the pid, the endpoint URL, and the log path, then exits 0 — the shell prompt returns.
- **`tlbx stop`** — new command (`apps/cli/src/commands/stop.ts`, registered in `apps/cli/src/index.ts`):
  - `-c, --config <path>` to find the state file next to a non-default config.
  - No state file, or a state file whose PID is not alive → report "not running" (clearing a stale file if present) and exit 0 (stop is idempotent).
  - Otherwise send `SIGTERM`, poll for exit up to a timeout (~5s), and if still alive escalate to `SIGKILL` and poll a bit more. Clear the state file and report what happened (stopped / force-killed). All of `kill`, `sleep`, the state helpers, and the path resolver are injected so the behavior is unit-testable without real processes.
- **Tests** for: state read/write/clear + `isProcessAlive`; the path resolver honoring the env overrides; `runServeDetached` (rejects `--stdio`, refuses when already running, clears stale state, builds the right spawn argv, writes state, handles immediate child death); `runStop` (not-running, stale-state, SIGTERM-then-exit, SIGTERM-timeout-then-SIGKILL).
- **Docs** — mention `tlbx serve --detach` and `tlbx stop` wherever `tlbx serve` is documented (README / CLI help text; `CLAUDE.md` if it enumerates commands).

## Acceptance criteria

- `tlbx serve --detach` returns to the shell prompt immediately; the bound HTTP endpoint responds and the daemon state file records the live pid; logs land in `serve.log`.
- Running `tlbx serve --detach` again while one is already running fails with a clear "already running (pid N)" message and does not spawn a second process.
- `tlbx stop` shuts down the detached gateway (graceful SIGTERM), removes the state file, and a subsequent `tlbx stop` reports "not running" and exits 0.
- A stale state file (PID no longer alive) does not block `tlbx serve --detach` and is reported/cleaned by `tlbx stop`.
- `tlbx serve --detach --stdio` exits non-zero with a descriptive error. `tlbx serve --detach` against a config with `server.http.enabled: false` fails the same way `tlbx serve --http` does — before forking.
- Killing the detached child directly (outside `tlbx stop`) leaves only a stale state file, which the next `tlbx serve --detach` / `tlbx stop` cleans up — no orphaned upstream child processes remain (the child's existing SIGTERM/SIGINT teardown still applies).

## Out of scope

- launchd / systemd / Windows Service registration (still deferred).
- Log rotation / size capping for `serve.log` (note as a future task if it becomes a problem).
- A `tlbx serve --detach` mode for stdio transport.
- Auto-restart / supervision of the detached process if it crashes.
- Surfacing daemon state inside `tlbx status` (could be a small follow-up).

## Definition of done

- Acceptance criteria hold (verified manually for the detach/stop round-trip, not just by unit tests).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- The work is committed referencing `F1-07`, the pre-commit hook ran clean, and the `F1-07` checkbox in `.agents/TASKS.md` is flipped with the closing commit / PR.
