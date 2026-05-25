# P2-04 — `tlbx run` discovery commands

**Milestone**: Phase 2 — CLI Tool Execution
**SPECS references**: §5.2, §5.6 (criterion 6)

## Goal

Make JSON-first tool execution discoverable without requiring users or agents to guess schemas.

## Deliverables

- Discovery forms under `tlbx run`:
  - `tlbx run --search <query>`
  - `tlbx run <server> --list`
  - `tlbx run <server> --search <query>`
  - `tlbx run <server> <tool> --describe`
  - `tlbx run <server> <tool> --schema`
  - `tlbx run <server> <tool> --example`
- Discovery uses the daemon's control-plane marker (§5.3): `--list` and `--search` enumerate all enabled tools regardless of the revealed set and never collapse to just the bootstrap tools, even when `progressiveDisclosure.enabled=true`.
- Search uses the same ranking as `toolbox__search_tools`.
- `--list` shows exposed name, server, upstream source, description, and enabled state.
- `--describe` shows title/description, required fields, optional fields, and an example `tlbx run ... --json ...` command.
- `--schema` prints the raw input schema as JSON.
- `--example` prints a generated JSON skeleton suitable for redirecting to a file.

## Acceptance criteria

- Discovery commands auto-start/reuse the daemon through P2-01.
- With `progressiveDisclosure.enabled=true` and nothing revealed, `--list` and `--search` still return the full enabled tool set, not just bootstrap tools.
- Search results match `tlbx tools search` and `toolbox__search_tools` ranking for the same query.
- `--schema` emits valid JSON.
- `--example` emits valid JSON for object-shaped schemas.
- Unknown tool discovery errors show nearby matches.

## Out of scope

- Shell completion generation.
- Perfect example generation for every possible JSON Schema construct; unsupported constructs may fall back to a placeholder with a clear marker.

## Definition of done

- Acceptance criteria hold.
- Tests cover list, global search, server-scoped search, describe, schema, example, and unknown-tool suggestions.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-04 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
