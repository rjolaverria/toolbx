# P3-05 — Expose custom tools through the MCP gateway and `tlbx run`

**Milestone**: Phase 3 — Custom JS/TS Tools
**SPECS references**: §6.7 (criteria 4, 5, 6, 7)

## Goal

Make imported, enabled custom tools first-class citizens of `tools/list`, `tools/call`, and daemon-backed `tlbx run`, alongside proxied upstream tools.

## Deliverables

- Extend the tool registry (M2-04) to also include entries from the custom tool manifest, marked with `source: 'custom'`.
- Extend the routing engine (M3-02) to dispatch `source: 'custom'` calls to the custom tool runtime (P3-03) instead of an upstream session.
- Honor namespacing rules from M3-01 — the custom tool's `namespace` is treated like a server name and goes through the same collision detector.
- Surface custom tools in the CLI's `tlbx tools list` (M5-02) and `tlbx run` discovery with a "custom" source indicator.
- Custom tools participate in progressive disclosure exactly like proxied tools.
- Keep `tlbx run` source-agnostic: it must not add a direct custom-tool execution branch. Custom tools become runnable only because they appear in gateway `tools/list` and are callable through gateway `tools/call`.

## Acceptance criteria

- An imported, enabled custom tool appears in `tools/list`, appears in `tlbx run` discovery, and is callable via `tools/call` from any MCP client connected to ToolBox (Claude / Codex / OpenCode / generic).
- The same custom tool is callable through `tlbx run <namespace> <tool> --json ...` because `tlbx run` uses the gateway `tools/call` path.
- A namespace collision between a custom tool and an upstream server is rejected at config validation time.
- Disabling a custom tool removes it from `tools/list`.
- Tests or contract fixtures prove `tlbx run` does not care whether a tool is upstream or custom once it is exposed by the gateway.

## Out of scope

- Hot-reloading custom tool source on file change (could come later).
- Per-client visibility rules.

## Definition of done

- Acceptance criteria hold.
- Integration tests are extended to cover the custom-tool path end-to-end with at least one fixture custom tool, including MCP `tools/call` and `tlbx run`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P3-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash. After this lands, mark Phase 3 (§6.7 acceptance criteria 1–10) as complete in `.agents/TASKS.md`.
