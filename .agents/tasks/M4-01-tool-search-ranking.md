# M4-01 — Deterministic tool search ranking

**Milestone**: 4 — Progressive Disclosure
**README references**: §4.5

## Goal

A pure search function over the tool registry that ranks results deterministically using the rules in README §4.5. Powers `toolbox__search_tools` (M4-03) and `tlbx tools search` (M5-02).

## Deliverables

- `packages/core/src/disclosure/search.ts` exporting `searchTools(query, tools, options)` returning a ranked list with `{ tool, score, matchedFields }`.
- Indexed fields: server name, tool name, tool title, tool description, input schema property names, input schema property descriptions, user-supplied tags/categories.
- Ranking order from README §4.5:
  1. Exact server match
  2. Exact namespace match
  3. Exact tool name match
  4. Description keyword match
  5. Input schema keyword match
  6. Fuzzy match (use a small, deterministic algorithm — e.g. token-overlap or a vendored fuzzy scorer with a fixed weight; avoid pulling in a heavy dependency).
- Honors `options.limit` (default `progressiveDisclosure.maxSearchResults` from config, falling back to 20).
- Stable tie-breaker on equal scores: alphabetical by exposed name.

## Acceptance criteria

- For a query exactly matching a server name, that server's tools rank above all others.
- For a query exactly matching a tool name, that tool ranks first overall.
- A query containing tokens from a description but no name matches lands in the description-match band, behind exact-name matches.
- Results are stable run-to-run.

## Out of scope

- Embeddings (explicitly deferred per README).
- Stemming or language-aware processing.

## Definition of done

- Acceptance criteria hold.
- Table-driven tests cover each of the six ranking bands plus tie-breaker behavior.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M4-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
