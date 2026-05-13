# ToolBox Tasks

This is the master todo list for delivering the ToolBox product as described in `.agents/SPECS.md`. Each entry links to a detailed task file in `.agents/tasks/`. Tasks are grouped by the milestones from `.agents/SPECS.md` §7. Phase 2 and Phase 3 work is included at the end.

## How to use this list

- Read the linked task file before starting work — it contains the goal, deliverables, acceptance criteria, and the SPECS sections it derives from.
- Work one task per branch / set of commits. Each task is a deliverable.
- A task is **only** completed when it passes the full quality bar: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run`, and the pre-commit hook. See `CLAUDE.md` → "Task Workflow" for the full rule.
- When a task is finished, flip its checkbox below from `[ ]` to `[x]` and add a one-line note pointing at the merge commit / PR.
- Do not mark a task complete just because the code compiles. Tests and the manual acceptance criteria from the task file must also pass.

## Status legend

- `[ ]` — not started
- `[~]` — in progress
- `[x]` — completed (must reference the commit/PR that closed it)

---

## Phase 1 — TypeScript CLI and MCP Proxy ✅

Phase 1 is complete: every milestone below (M0 through M5) is closed and the SPECS §4.8 acceptance criteria are exercised end-to-end by the M5-06 integration suite.

## Milestone 0 — Skeleton

- [x] **M0-01** — [Config schema, loader, and validator](tasks/M0-01-config-schema-and-loader.md) — closed by 7fdaf2f
- [x] **M0-02** — [Logger module](tasks/M0-02-logger-module.md) — closed by 66ad626
- [x] **M0-03** — [`tlbx init` command](tasks/M0-03-cli-init-command.md) — closed by 585455a

## Milestone 1 — Upstream Connection Manager

- [x] **M1-01** — [Upstream stdio MCP client](tasks/M1-01-upstream-stdio-client.md) — closed by 69e0c5a
- [x] **M1-02** — [Upstream Streamable HTTP MCP client](tasks/M1-02-upstream-http-client.md) — closed by a921d95
- [x] **M1-03** — [Upstream session lifecycle and reconnect](tasks/M1-03-upstream-session-lifecycle.md) — closed by 4d5da9c
- [x] **M1-04** — [Server status registry and state machine](tasks/M1-04-server-status-registry.md) — closed by 0e5bb61
- [x] **M1-05** — [`tlbx server add-stdio` and `add-http` commands](tasks/M1-05-server-add-commands.md) — closed by 3dbb09f
- [x] **M1-06** — [`tlbx server list/status/enable/disable/remove/edit/inspect` commands](tasks/M1-06-server-management-commands.md) — closed by 6dc77d6

## Milestone 2 — Downstream ToolBox MCP Server

- [x] **M2-01** — [Downstream MCP server over stdio](tasks/M2-01-downstream-stdio-server.md) — closed by 9d6a608
- [x] **M2-02** — [Downstream MCP server over Streamable HTTP](tasks/M2-02-downstream-http-server.md) — closed by 4156c86
- [x] **M2-03** — [`initialize`, `notifications/initialized`, `ping` handlers](tasks/M2-03-initialize-and-ping-handlers.md) — closed by 0747abb
- [x] **M2-04** — [`tools/list` handler (non-disclosure mode)](tasks/M2-04-tools-list-handler.md) — closed by 01ca332
- [x] **M2-05** — [`tools/call` handler with upstream routing](tasks/M2-05-tools-call-handler.md) — closed by 6c0f2a5
- [x] **M2-06** — [`tlbx serve` command (stdio + http modes)](tasks/M2-06-cli-serve-command.md) — closed by 7b19f77

## Milestone 3 — Proxy Routing

- [x] **M3-01** — [Namespacing module (separator, format, collision strategy)](tasks/M3-01-namespacing-module.md) — closed by 74fe794
- [x] **M3-02** — [Tool routing engine: namespaced call → upstream call](tasks/M3-02-tool-routing-engine.md) — closed by 20d20c4
- [x] **M3-03** — [Timeout, error, and disabled-server handling for proxied calls](tasks/M3-03-proxy-error-and-timeout-handling.md) — closed by 59dabf5

## Milestone 4 — Progressive Disclosure

- [x] **M4-01** — [Deterministic tool search ranking](tasks/M4-01-tool-search-ranking.md) — closed by 7b97dc8
- [x] **M4-02** — [Session-visible tool registry](tasks/M4-02-session-visible-tool-registry.md) — closed by 6bfcf70
- [x] **M4-03** — [Bootstrap tool: `toolbox__search_tools`](tasks/M4-03-bootstrap-search-tools.md) — closed by d65d140
- [x] **M4-04** — [Bootstrap tools: `toolbox__reveal_tools` and `toolbox__hide_tools`](tasks/M4-04-bootstrap-reveal-and-hide-tools.md) — closed by 583f55e
- [x] **M4-05** — [Bootstrap tools: `toolbox__list_available_servers` and `toolbox__list_revealed_tools`](tasks/M4-05-bootstrap-list-tools.md) — closed by ff5410e
- [x] **M4-06** — [`tools/list_changed` notification on visibility changes](tasks/M4-06-tools-list-changed-notification.md) — closed by db078e1
- [x] **M4-07** — [Progressive disclosure config toggle in `tools/list`](tasks/M4-07-progressive-disclosure-toggle.md) — closed by a5039ea

## Milestone 5 — Client Compatibility & UX Polish

- [x] **M5-01** — [`tlbx client print-config` for Claude / Codex / OpenCode / generic](tasks/M5-01-client-print-config-command.md) — closed by 82005c6
- [x] **M5-02** — [`tlbx tools` commands (list / search / enable / disable)](tasks/M5-02-cli-tools-commands.md) — closed by af81a3c
- [x] **M5-03** — [`tlbx config` commands (path / edit / validate / set)](tasks/M5-03-cli-config-commands.md) — closed by 707f8e8
- [x] **M5-04** — [`tlbx status` command](tasks/M5-04-cli-status-command.md) — closed by abbde54
- [x] **M5-05** — [`tlbx doctor` command](tasks/M5-05-cli-doctor-command.md) — closed by 01b4723
- [x] **M5-06** — [End-to-end MCP client integration tests](tasks/M5-06-integration-tests.md) — closed by 63837a6

## Phase 1 follow-ups

These are items that fell out of the Phase 1 review (post M5-06). They are not part of any closed milestone — each was identified as a real gap or an intentional deferral that now needs scheduling. They should land before Phase 2 work begins.

- [x] **F1-01** — [GitHub Actions CI workflow](tasks/F1-01-github-actions-ci.md) — closed by 7917215
- [x] **F1-02** — [Honor `progressiveDisclosure.autoRevealExactServerMatches` in search](tasks/F1-02-auto-reveal-exact-server-matches.md) — closed by 96c1da8
- [x] **F1-03** — [`tlbx doctor --fix` safe fixers](tasks/F1-03-doctor-fix-safe-fixers.md) — closed by f596b9e
- [x] **F1-04** — [Vitest coverage thresholds](tasks/F1-04-vitest-coverage-thresholds.md) — closed by c868c1c
- [x] **F1-05** — [Gateway-level integration tests](tasks/F1-05-gateway-integration-tests.md) — closed by e5e5e57
- [ ] **F1-06** — [Phase 2 spec clarifications](tasks/F1-06-phase2-spec-clarifications.md)
- [x] **F1-07** — [`tlbx serve --detach` and `tlbx stop`](tasks/F1-07-serve-detach-and-stop.md) — closed by d8853bf

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
