# P2-03 — MCP Servers manager screen + Add Server wizards

**Milestone**: Phase 2 — Electron UI
**SPECS references**: §5.3 (MCP Servers, Add Server Wizard), §5.4 (criteria 1, 2, 3, 4, 5)

## Goal

A screen to add, edit, enable/disable, restart, remove, and inspect upstream MCP servers, plus the two Add Server wizards (stdio, HTTP).

## Deliverables

- Servers route in the renderer with a table showing every configured server with the columns from SPECS §5.3 (name, type, enabled/disabled, connection status, auth status, tool count, last connected, last error). Row actions: edit, disable, remove, restart, inspect tools, test connection.
- Add Server wizard with two flows:
  - **stdio**: name, command, arguments, environment variables, working directory, timeout.
  - **HTTP**: name, URL, auth type (none / bearer), headers, timeout.
- Wizards reuse the Zod schema from `@toolbox/core` for validation; error messages match the CLI.
- "Test connection" calls into the main process to attempt a one-shot connect and reports the result inline.

## Acceptance criteria

- Adding a server produces the same config entry the CLI would (exercised via a snapshot test with a shared fixture).
- Edits validate live and disable the Save button on invalid input.
- Disable / Enable / Remove / Restart match the behavior of the corresponding `tlbx server …` commands.
- Inspect Tools opens the Tool inventory pre-filtered to that server (defined in P2-04).

## Out of scope

- OAuth setup flows (Phase 1 deferred).
- Importing config from another MCP client.

## Definition of done

- Acceptance criteria hold.
- Component tests cover the table, the two wizard happy paths, and at least one validation failure per wizard.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-03 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
