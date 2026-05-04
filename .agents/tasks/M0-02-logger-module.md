# M0-02 — Logger module

**Milestone**: 0 — Skeleton
**SPECS references**: §4.6 (logging capture/proxy), §7 (Milestone 0)

## Goal

Provide a single logger used everywhere in `@toolbox/core`, `@toolbox/mcp-gateway`, and the CLI. The logger has to work in two modes: a human-readable mode for the CLI (stderr) and a structured JSON mode that the gateway can later forward through MCP `logging` notifications.

## Approach

Use [`pino`](https://github.com/pinojs/pino) as the underlying logger. Pino already provides every load-bearing requirement: the five log levels we need (`trace | debug | info | warn | error`, plus `fatal` and `silent`), `child(bindings)`, JSON-per-line output, configurable destinations and `Writable` streams, level filtering, and a `silent` level for tests. `@toolbox/core` exposes a thin factory that wires our defaults onto `pino()` so call sites stay short and consistent.

Pretty output is produced via [`pino-pretty`](https://github.com/pinojs/pino-pretty) used as a synchronous transformer stream (no worker threads, no `pino.transport`).

## Deliverables

- `packages/core/src/logging/logger.ts` exporting:
  - `createLogger(options)` factory. `CreateLoggerOptions` controls level, format (`pretty | json`), destination (`'stderr' | 'stdout' | NodeJS.WritableStream`), and base bindings (e.g. `{ server: 'jira' }`).
  - `createNoopLogger()` — pino at level `silent` for tests.
  - Re-exports of `Logger` and `LogLevel` (= pino's `Level`) for consumers.
- Public exports through `packages/core/src/index.ts`.
- `pino` and `pino-pretty` added to `@toolbox/core` `dependencies`.

## Acceptance criteria

- Loggers in stdio mode **must** write to stderr only — stdout is reserved for the MCP protocol. The default destination is `'stderr'`.
- Levels filter correctly: a logger created at `info` drops `debug` and `trace` calls; `silent` drops everything.
- `child()` merges bindings; child bindings shadow parent bindings on key collision.
- JSON output is one object per line, with ISO-8601 `time`, a `level` field, `msg`, and the merged bindings. `pid` and `hostname` are suppressed (pino's `base: null` / explicit base).
- Pretty output is human-readable but contains no ANSI when `process.stdout.isTTY` is false (achieved via `pino-pretty`'s `colorize` flag set to `process.stdout.isTTY === true`).

## Out of scope

- Forwarding logs over the MCP protocol — that lives with the downstream server task (M2-01 / M2-03).
- Persistent log storage / log files.
- A bespoke `Logger` interface or `parseLogLevel` helper — pino's types and runtime cover both.

## Definition of done

- Acceptance criteria above hold.
- Unit tests cover level filtering, child bindings, stream selection (stderr vs stdout vs custom Writable), JSON shape, pretty-mode ANSI gating, and the no-op logger.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M0-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
