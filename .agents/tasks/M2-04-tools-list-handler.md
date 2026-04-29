# M2-04 — `tools/list` handler (non-disclosure mode)

**Milestone**: 2 — Downstream Toolbox MCP Server
**README references**: §2.3, §2.4 (off mode), §4.6, §4.8 (criterion 6)

## Goal

Implement `tools/list` for the case where progressive disclosure is **off**: return every enabled, namespaced tool from every connected upstream server. M4-07 will layer the on/off toggle on top.

## Deliverables

- `packages/mcp-gateway/src/downstream-server/handlers/tools-list.ts`:
  - Reads from the shared in-memory tool registry (built by aggregating `listTools()` results from each upstream session).
  - Applies namespacing from the M3-01 module to each upstream tool.
  - Skips servers in `disabled`, `error`, `auth_required`, or `auth_expired` status.
  - Returns the tools in a stable order: by namespace ascending, then tool name ascending.
- `packages/mcp-gateway/src/registry/tool-registry.ts`:
  - Holds `{ exposedName, serverName, upstreamName, title, description, inputSchema }` per tool.
  - Refreshed when `notifications/tools/list_changed` arrives from any upstream session.

## Acceptance criteria

- With two healthy upstream servers and progressive disclosure off, `tools/list` returns the union of their tools, all namespaced.
- Disabling a server (in config) immediately omits its tools from subsequent `tools/list` responses.
- A server stuck in `auth_required` does not contribute tools.
- Order is deterministic and snapshot-tested.

## Out of scope

- Progressive disclosure logic (M4-07).
- Pagination (defer until upstream tool counts exceed a few hundred).

## Definition of done

- Acceptance criteria hold.
- Tests use fake upstream sessions with deterministic tool sets and assert the response.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M2-04 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
