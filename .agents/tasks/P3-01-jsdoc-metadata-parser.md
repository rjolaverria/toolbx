# P3-01 — JSDoc tool metadata parser

**Milestone**: Phase 3 — Custom JS/TS Tools
**SPECS references**: §6.2, §6.7 (criterion 2)

## Goal

Extract the `@toolbox-tool` JSDoc directives from a user-provided `.ts` / `.js` tool file. Pure parsing; no execution.

## Deliverables

- New package `packages/custom-tools/` (per SPECS §4.7) with `src/manifest/parse.ts` exporting `parseToolMetadata(source, filename)` returning `{ name, title, description, namespace }` (all required) plus any unknown directives surfaced as warnings.
- Reads `inputSchema` export presence (without evaluating it) so the importer (P3-02) can validate later.
- Friendly error messages pointing at the offending JSDoc line.

## Acceptance criteria

- Parses the SPECS §6.2 example into the exact metadata shown there.
- Missing required directives produce errors that name the missing directive and the source path.
- Multiple `@toolbox-tool` blocks are not allowed; the parser reports the duplicate.

## Out of scope

- Evaluating the file (P3-02).
- Type-checking the input schema (Zod validates at runtime; static type-checking happens during `pnpm typecheck` of the user's own code, not here).

## Definition of done

- Acceptance criteria hold.
- Tests cover the happy path, every required-field error, and the duplicate-directive error.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P3-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
