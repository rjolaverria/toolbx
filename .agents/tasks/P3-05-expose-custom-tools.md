# P3-05 — Expose custom tools through the MCP gateway

**Milestone**: Phase 3 — Custom JS/TS Tools
**SPECS references**: §6.7 (criteria 4, 5, 6, 7)

## Goal

Make imported, enabled custom tools first-class citizens of `tools/list` and `tools/call`, alongside proxied upstream tools.

## Deliverables

- Extend the tool registry (M2-04) to also include entries from the custom tool manifest, marked with `source: 'custom'`.
- Extend the routing engine (M3-02) to dispatch `source: 'custom'` calls to the custom tool runtime (P3-03) instead of an upstream session.
- Honor namespacing rules from M3-01 — the custom tool's `namespace` is treated like a server name and goes through the same collision detector.
- Surface custom tools in the CLI's `tlbx tools list` (M5-02) and the UI's tool inventory (P2-04) with a "custom" badge.
- Custom tools participate in progressive disclosure exactly like proxied tools.

## Acceptance criteria

- An imported, enabled custom tool appears in `tools/list` and is callable via `tools/call` from any MCP client connected to ToolBox (Claude / Codex / OpenCode / generic).
- A namespace collision between a custom tool and an upstream server is rejected at config validation time.
- Disabling a custom tool removes it from `tools/list`.

## Out of scope

- Hot-reloading custom tool source on file change (could come later).
- Per-client visibility rules.

## Definition of done

- Acceptance criteria hold.
- Integration tests in M5-06 are extended to cover the custom-tool path end-to-end with at least one fixture custom tool.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P3-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash. After this lands, mark Phase 3 (§6.7 acceptance criteria 1–9) as complete in `.agents/TASKS.md`.
