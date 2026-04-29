# M4-06 — `tools/list_changed` notification on visibility changes

**Milestone**: 4 — Progressive Disclosure
**README references**: §2.4, §4.6 (Must Have), §7 (Milestone 4)

## Goal

Emit `notifications/tools/list_changed` on the downstream MCP server whenever the visible tool set changes for a session — whether from reveal/hide, upstream `tools_list_changed`, server enable/disable, or progressive-disclosure toggle.

## Deliverables

- Wire `sessionVisibility.on('change')` (M4-02) to send the notification through the SDK server in `packages/mcp-gateway/src/downstream-server`.
- Wire upstream `tools_list_changed` events from M1-03 sessions to refresh the registry (M2-04) and, where it changes the per-session visible set, send the notification.
- Debounce notifications per session at 50ms to coalesce rapid changes (e.g. revealing 10 tools in one call should produce a single notification).

## Acceptance criteria

- A single `reveal_tools({ tools: [a, b, c] })` call results in exactly one `notifications/tools/list_changed` to the calling session.
- An upstream server appearing or disappearing emits a notification to every active downstream session.
- Toggling `progressiveDisclosure.enabled` (via M5-03) emits a notification to all active sessions.

## Out of scope

- Cross-instance notifications (Toolbox runs as a single process today).
- Differentiating "visibility changed" from "schema changed" — Phase 1 always re-emits a single notification kind.

## Definition of done

- Acceptance criteria hold.
- Integration tests assert the notification count for each scenario.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M4-06 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
