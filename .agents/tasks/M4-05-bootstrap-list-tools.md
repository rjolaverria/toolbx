# M4-05 — Bootstrap tools: `toolbox__list_available_servers` and `toolbox__list_revealed_tools`

**Milestone**: 4 — Progressive Disclosure
**SPECS references**: §2.4

## Goal

Two read-only bootstrap tools an agent can use to introspect ToolBox without revealing tools.

## Deliverables

- `packages/mcp-gateway/src/bootstrap-tools/list-available-servers.ts`:
  - Input: `{}`.
  - Returns one entry per configured server: `{ name, type, enabled, status, toolCount }`.
  - Skips disabled servers unless `{ includeDisabled: true }` is passed.
- `packages/mcp-gateway/src/bootstrap-tools/list-revealed-tools.ts`:
  - Input: `{}`.
  - Returns the current session's revealed exposed tool names plus the bootstrap tools (so the agent sees the full visible surface).

## Acceptance criteria

- `list_available_servers` reflects live status from the M1-04 registry.
- `list_revealed_tools` always includes bootstrap tools even when no upstream tools are revealed.
- Both tools never mutate session visibility.

## Out of scope

- Per-tool metadata for revealed tools beyond the exposed name (the agent can call `search_tools` for details).

## Definition of done

- Acceptance criteria hold.
- Tests cover both tools against fake registries.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M4-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
