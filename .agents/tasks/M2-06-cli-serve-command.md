# M2-06 — `tlbx serve` command

**Milestone**: 2 — Downstream Toolbox MCP Server
**README references**: §4.1, §4.2, §4.3, §4.8 (criteria 4 and 5)

## Goal

Top-level CLI command that boots Toolbox: load config, connect upstream sessions, start the downstream MCP server in stdio or HTTP mode.

## Deliverables

- `apps/cli/src/commands/serve.ts` adding `tlbx serve` with options:
  - `--stdio` (default if neither flag is set in stdio-only build) and `--http` flags. They are mutually exclusive.
  - `--config <path>` to override the resolved config path for one run.
  - `--log-level <trace|debug|info|warn|error>` and `--log-format <pretty|json>`.
- Loads config via `@toolbox/core`, instantiates the status registry (M1-04), starts upstream sessions (M1-03) for every enabled server, then starts the matching downstream server (M2-01 or M2-02).
- On SIGINT/SIGTERM, gracefully disposes downstream then upstream sessions and exits 0.
- In stdio mode, the CLI must not write anything to stdout itself — only the MCP gateway does.

## Acceptance criteria

- `tlbx serve --stdio` is wireable into Claude Desktop's MCP config (per README §4.3) and a manual `initialize` round-trip succeeds.
- `tlbx serve --http` binds the host/port from config and listens on the configured path.
- Killing the process with SIGINT cleanly tears down upstream child processes (verified by checking no orphaned PIDs remain in tests).
- Passing both `--stdio` and `--http` exits non-zero with a descriptive error.

## Out of scope

- A persistent daemon / launchd / systemd integration.
- Hot reload on config changes (could be M5+).

## Definition of done

- Acceptance criteria hold.
- Tests boot `tlbx serve --http` against a temp config with one upstream stdio fixture, run a full client round trip, and shut down.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M2-06 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
