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
- [x] **F1-06** — [Phase 2 spec clarifications](tasks/F1-06-phase2-spec-clarifications.md) — closed by d34c15b
- [x] **F1-07** — [`tlbx serve --detach` and `tlbx stop`](tasks/F1-07-serve-detach-and-stop.md) — closed by d8853bf
- [x] **F1-08** — [Client adapter framework and Claude Code adapter](tasks/F1-08-client-adapter-framework.md) — closed by this PR
- [x] **F1-09** — [Codex + OpenCode adapters and `tlbx client install` command](tasks/F1-09-client-install-command.md) — closed by this PR
- [x] **F1-10** — [`tlbx setup` orchestrator and README rewrite](tasks/F1-10-setup-command.md) — closed by this PR
- [x] **F1-11** — [Drop Claude Desktop from `client print-config`; align `claude` keyword](tasks/F1-11-client-print-config-claude-code.md) — closed by this PR
- [x] **F1-12** — [OAuth config schema (`auth.storage` + `auth.type === 'oauth'`)](tasks/F1-12-oauth-config-schema.md) — closed by this PR
- [x] **F1-13** — [`TokenStore` interface, factory, `InMemoryTokenStore`](tasks/F1-13-token-store-interface.md) — closed by this PR
- [x] **F1-14** — [`KeychainTokenStore` (dynamic-import `@napi-rs/keyring`)](tasks/F1-14-keychain-token-store.md) — closed by ab74305
- [x] **F1-15** — [OAuth discovery probe (`probeUpstreamAuth` + `AuthHint`)](tasks/F1-15-oauth-discovery.md) — closed by this PR
- [x] **F1-16** — [OAuth callback server (loopback HTTP, single-shot, timeout)](tasks/F1-16-oauth-callback-server.md) — closed by this PR
- [x] **F1-17** — [`OAuthClientProvider` implementation (SDK adapter)](tasks/F1-17-oauth-client-provider.md) — closed by this PR
- [x] **F1-18** — [`runOAuthLogin` orchestrator](tasks/F1-18-run-oauth-login.md) — closed by this PR
- [x] **F1-19** — [`tlbx auth login | logout | status | refresh` commands](tasks/F1-19-auth-cli-commands.md) — closed by 3939da9 (branch `f1-19-auth-cli-commands`)
- [x] **F1-20** — [`server add-http` probe-and-trigger integration](tasks/F1-20-add-http-oauth-integration.md) — closed by PR #63 (branch `f1-20-add-http-oauth-integration`)
- [x] **F1-21** — [Gateway OAuth wiring + lazy refresh + `auth_expired` surface](tasks/F1-21-gateway-oauth-wiring.md) — closed by PR #64 (branch `f1-21-gateway-oauth-wiring`)
- [x] **F1-22** — [`tlbx doctor` OAuth drift check + `--fix`](tasks/F1-22-doctor-oauth-drift.md) — closed by PR #65 (branch `f1-22-doctor-oauth-drift`)
- [x] **F1-23** — [End-to-end OAuth integration tests + CI security gates](tasks/F1-23-oauth-integration-tests.md) — closed by 4ac57f6; CLI snapshots manually reviewed for token-byte leakage
- [x] **F1-24** — [Persist and replay the OAuth resource indicator on refresh](tasks/F1-24-oauth-refresh-resource-indicator.md) — closed by PR #67 (branch `f1-24-oauth-refresh-resource-indicator`)

## Phase 2 — CLI Tool Execution ✅

Phase 2 is complete: every task below (P2-01 through P2-06) is closed. The SPECS §5.6 acceptance criteria 1–10 are covered across the Phase 2 tasks' tests; the P2-06 daemon-backed integration suite exercises the daemon lifecycle and the core `tlbx run` paths (auto-start, reuse, concurrent convergence, same-port collision, forced HTTP, stop, input/output modes, disabled-tool remediation, HTTP success and timeout, and discovery) end-to-end against real fixtures. Per-mode auth/browser-safety remediation remains covered by the P2-05 and OAuth suites rather than this integration suite.

- [x] **P2-01** — [`tlbx run` daemon auto-start and readiness](tasks/P2-01-run-daemon-autostart.md) — closed by PR #70 (branch `p2-01-run-daemon-autostart`)
- [x] **P2-02** — [`tlbx run` command and JSON input modes](tasks/P2-02-run-command-inputs.md) — closed by branch `p2-02-run-command-inputs`
- [x] **P2-03** — [`tlbx run` output modes and exit contract](tasks/P2-03-run-output-contract.md) — closed by bd7415e (branch `p2-03-run-output-contract`)
- [x] **P2-04** — [`tlbx run` discovery commands](tasks/P2-04-run-discovery.md) — closed by e7f0014 (branch `p2-04-run-discovery`)
- [x] **P2-05** — [`tlbx run` auth, errors, and remediation](tasks/P2-05-run-errors-auth.md) — closed by PR #74 (branch `p2-05-run-errors-auth`)
- [x] **P2-06** — [`tlbx run` daemon-backed integration tests](tasks/P2-06-run-integration-tests.md) — closed by f2d502d (branch `p2-06-run-integration-tests`)

## Phase 3 — Custom JS/TS Tools

- [x] **P3-01** — [JSDoc tool metadata parser](tasks/P3-01-jsdoc-metadata-parser.md) — closed by 56b7813 (branch `p3-01-jsdoc-metadata-parser`)
- [x] **P3-02** — [Custom tool importer + manifest generator](tasks/P3-02-tool-importer-and-manifest.md) — closed by e5a211b (branch `p3-02-tool-importer-and-manifest`)
- [x] **P3-03** — [Custom tool runtime with timeouts and permissions](tasks/P3-03-tool-runtime.md) — closed by 5ddbe8c (branch `p3-03-tool-runtime`)
- [ ] **P3-04** — [`tlbx tool` CLI commands (import/list/inspect/enable/disable/remove)](tasks/P3-04-cli-tool-commands.md)
- [ ] **P3-05** — [Expose custom tools through the MCP gateway and `tlbx run`](tasks/P3-05-expose-custom-tools.md)
- [ ] **P3-06** — [OS-level sandbox for custom tools](tasks/P3-06-os-level-sandbox.md) — filed from P3-03 review; stronger isolation deferred per SPECS §6.6
