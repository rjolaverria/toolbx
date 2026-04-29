# M4-03 — Bootstrap tool: `toolbox__search_tools`

**Milestone**: 4 — Progressive Disclosure
**README references**: §2.4

## Goal

The first bootstrap tool: surfaces matching tool candidates from across all enabled upstream servers without revealing them.

## Deliverables

- `packages/mcp-gateway/src/bootstrap-tools/search-tools.ts` exporting a registration helper that adds the `toolbox__search_tools` tool to the downstream server.
- Input schema (validated with Zod, surfaced as JSON Schema): `{ query: string, limit?: number, includeRevealed?: boolean }`.
- Calls into `searchTools` from M4-01, returning each candidate's exposed name, server name, original tool name, title, description, and an excerpt of the input schema (property names + descriptions only).
- Returns content as MCP `text` blocks with one JSON line per candidate, plus a final summary line.
- Honors `progressiveDisclosure.maxSearchResults` from config as the upper bound on `limit`.

## Acceptance criteria

- Calling `toolbox__search_tools` with a query that matches a server name returns that server's tools first.
- The tool exists in `tools/list` regardless of progressive-disclosure state when `bootstrapTools: true` in config.
- The response never reveals tools — calling it does not modify session visibility.

## Out of scope

- Auto-revealing matches (handled by M4-04 / `reveal_tools`).
- Multi-step search (rephrase, paginate) — keep the surface minimal in Phase 1.

## Definition of done

- Acceptance criteria hold.
- Tests register the bootstrap tool against a fake downstream server and assert the response shape and ranking order.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M4-03 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
