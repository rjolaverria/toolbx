# Toolbox Tasks

This is the master todo list for delivering the Toolbox product as described in `README.md`. Each entry links to a detailed task file in `.agents/tasks/`. Tasks are grouped by the milestones from `README.md` §7. Phase 2 and Phase 3 work is included at the end.

## How to use this list

- Read the linked task file before starting work — it contains the goal, deliverables, acceptance criteria, and the README sections it derives from.
- Work one task per branch / set of commits. Each task is a deliverable.
- A task is **only** completed when it passes the full quality bar: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run`, and the pre-commit hook. See `CLAUDE.md` → "Task Workflow" for the full rule.
- When a task is finished, flip its checkbox below from `[ ]` to `[x]` and add a one-line note pointing at the merge commit / PR.
- Do not mark a task complete just because the code compiles. Tests and the manual acceptance criteria from the task file must also pass.

## Status legend

- `[ ]` — not started
- `[~]` — in progress
- `[x]` — completed (must reference the commit/PR that closed it)

---

## Milestone 0 — Skeleton

- [x] **M0-01** — [Config schema, loader, and validator](tasks/M0-01-config-schema-and-loader.md) — closed by 7fdaf2f
- [x] **M0-02** — [Logger module](tasks/M0-02-logger-module.md) — closed by 66ad626
- [x] **M0-03** — [`tlbx init` command](tasks/M0-03-cli-init-command.md) — closed by 585455a

## Milestone 1 — Upstream Connection Manager

- [x] **M1-01** — [Upstream stdio MCP client](tasks/M1-01-upstream-stdio-client.md) — closed by 69e0c5a
- [x] **M1-02** — [Upstream Streamable HTTP MCP client](tasks/M1-02-upstream-http-client.md) — closed by a921d95
- [x] **M1-03** — [Upstream session lifecycle and reconnect](tasks/M1-03-upstream-session-lifecycle.md) — closed by 4d5da9c
- [ ] **M1-04** — [Server status registry and state machine](tasks/M1-04-server-status-registry.md)
- [ ] **M1-05** — [`tlbx server add-stdio` and `add-http` commands](tasks/M1-05-server-add-commands.md)
- [ ] **M1-06** — [`tlbx server list/status/enable/disable/remove/edit/inspect` commands](tasks/M1-06-server-management-commands.md)

## Milestone 2 — Downstream Toolbox MCP Server

- [ ] **M2-01** — [Downstream MCP server over stdio](tasks/M2-01-downstream-stdio-server.md)
- [ ] **M2-02** — [Downstream MCP server over Streamable HTTP](tasks/M2-02-downstream-http-server.md)
- [ ] **M2-03** — [`initialize`, `notifications/initialized`, `ping` handlers](tasks/M2-03-initialize-and-ping-handlers.md)
- [ ] **M2-04** — [`tools/list` handler (non-disclosure mode)](tasks/M2-04-tools-list-handler.md)
- [ ] **M2-05** — [`tools/call` handler with upstream routing](tasks/M2-05-tools-call-handler.md)
- [ ] **M2-06** — [`tlbx serve` command (stdio + http modes)](tasks/M2-06-cli-serve-command.md)

## Milestone 3 — Proxy Routing

- [ ] **M3-01** — [Namespacing module (separator, format, collision strategy)](tasks/M3-01-namespacing-module.md)
- [ ] **M3-02** — [Tool routing engine: namespaced call → upstream call](tasks/M3-02-tool-routing-engine.md)
- [ ] **M3-03** — [Timeout, error, and disabled-server handling for proxied calls](tasks/M3-03-proxy-error-and-timeout-handling.md)

## Milestone 4 — Progressive Disclosure

- [ ] **M4-01** — [Deterministic tool search ranking](tasks/M4-01-tool-search-ranking.md)
- [ ] **M4-02** — [Session-visible tool registry](tasks/M4-02-session-visible-tool-registry.md)
- [ ] **M4-03** — [Bootstrap tool: `toolbox__search_tools`](tasks/M4-03-bootstrap-search-tools.md)
- [ ] **M4-04** — [Bootstrap tools: `toolbox__reveal_tools` and `toolbox__hide_tools`](tasks/M4-04-bootstrap-reveal-and-hide-tools.md)
- [ ] **M4-05** — [Bootstrap tools: `toolbox__list_available_servers` and `toolbox__list_revealed_tools`](tasks/M4-05-bootstrap-list-tools.md)
- [ ] **M4-06** — [`tools/list_changed` notification on visibility changes](tasks/M4-06-tools-list-changed-notification.md)
- [ ] **M4-07** — [Progressive disclosure config toggle in `tools/list`](tasks/M4-07-progressive-disclosure-toggle.md)

## Milestone 5 — Client Compatibility & UX Polish

- [ ] **M5-01** — [`tlbx client print-config` for Claude / Codex / OpenCode / generic](tasks/M5-01-client-print-config-command.md)
- [ ] **M5-02** — [`tlbx tools` commands (list / search / enable / disable)](tasks/M5-02-cli-tools-commands.md)
- [ ] **M5-03** — [`tlbx config` commands (path / edit / validate / set)](tasks/M5-03-cli-config-commands.md)
- [ ] **M5-04** — [`tlbx status` command](tasks/M5-04-cli-status-command.md)
- [ ] **M5-05** — [`tlbx doctor` command](tasks/M5-05-cli-doctor-command.md)
- [ ] **M5-06** — [End-to-end MCP client integration tests](tasks/M5-06-integration-tests.md)

## Phase 2 — Electron Desktop UI

- [ ] **P2-01** — [Electron app shell wired to `@toolbox/core`](tasks/P2-01-electron-app-shell.md)
- [ ] **P2-02** — [Dashboard screen](tasks/P2-02-ui-dashboard.md)
- [ ] **P2-03** — [MCP Servers manager screen + Add Server wizards](tasks/P2-03-ui-server-manager.md)
- [ ] **P2-04** — [Tool inventory screen](tasks/P2-04-ui-tool-inventory.md)
- [ ] **P2-05** — [Progressive disclosure settings screen](tasks/P2-05-ui-progressive-disclosure.md)
- [ ] **P2-06** — [Client setup snippet screen](tasks/P2-06-ui-client-setup.md)
- [ ] **P2-07** — [Logs screen with filters](tasks/P2-07-ui-logs.md)

## Phase 3 — Custom JS/TS Tools

- [ ] **P3-01** — [JSDoc tool metadata parser](tasks/P3-01-jsdoc-metadata-parser.md)
- [ ] **P3-02** — [Custom tool importer + manifest generator](tasks/P3-02-tool-importer-and-manifest.md)
- [ ] **P3-03** — [Custom tool runtime with timeouts and permissions](tasks/P3-03-tool-runtime.md)
- [ ] **P3-04** — [`tlbx tool` CLI commands (import/list/inspect/enable/disable/remove)](tasks/P3-04-cli-tool-commands.md)
- [ ] **P3-05** — [Expose custom tools through the MCP gateway](tasks/P3-05-expose-custom-tools.md)
