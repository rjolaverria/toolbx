# M0-02 — Logger module

**Milestone**: 0 — Skeleton
**README references**: §4.6 (logging capture/proxy), §7 (Milestone 0)

## Goal

Provide a single logger used everywhere in `@toolbox/core`, `@toolbox/mcp-gateway`, and the CLI. The logger has to work in two modes: a human-readable mode for the CLI (stderr) and a structured mode that the gateway can later forward through MCP `logging` notifications.

## Deliverables

- `packages/core/src/logging/logger.ts` exporting:
  - `Logger` interface with `trace | debug | info | warn | error` plus a `child(bindings)` method.
  - `createLogger(options)` factory. Options control level, format (`pretty | json`), destination (`stderr | stdout | writable`), and base bindings (e.g. `{ server: 'jira' }`).
- `packages/core/src/logging/levels.ts` with the level ordering and a `parseLogLevel` helper.
- A no-op logger for tests.
- Public exports through `packages/core/src/index.ts`.

## Acceptance criteria

- Loggers in stdio mode **must** write to stderr only — stdout is reserved for the MCP protocol.
- Levels filter correctly: a logger created at `info` drops `debug` and `trace` calls.
- `child()` merges bindings; child bindings shadow parent bindings on key collision.
- JSON output is one object per line and includes `time`, `level`, `msg`, plus bindings.
- Pretty output is human-readable but contains no ANSI when `process.stdout.isTTY` is false.

## Out of scope

- Forwarding logs over the MCP protocol — that lives with the downstream server task (M2-01 / M2-03).
- Persistent log storage / log files.

## Definition of done

- Acceptance criteria above hold.
- Unit tests cover level filtering, child bindings, and stream selection (stderr vs stdout).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M0-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
