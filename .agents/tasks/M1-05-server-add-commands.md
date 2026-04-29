# M1-05 — `tlbx server add-stdio` and `add-http` commands

**Milestone**: 1 — Upstream Connection Manager
**README references**: §4.2, §4.4, §4.8 (criteria 2 and 3)

## Goal

CLI commands to register a new upstream MCP server in the global config.

## Deliverables

- `apps/cli/src/commands/server-add.ts` adding two Commander subcommands under `server`:
  - `tlbx server add-stdio <name> -- <command...>` with options `--arg <arg...>` (repeatable), `--env KEY=VALUE` (repeatable), `--cwd <path>`, `--timeout <ms>`, `--disabled`.
  - `tlbx server add-http <name> --url <url>` with options `--auth <none|bearer>`, `--token-env <NAME>`, `--header KEY=VALUE` (repeatable), `--timeout <ms>`, `--disabled`.
- Both commands:
  - Reject duplicate server names (use the existing collision strategy from config).
  - Validate the resulting config through Zod before writing.
  - Write atomically via `@toolbox/core` `config/save.ts`.
  - Print the new server entry as JSON to stdout on success.

## Acceptance criteria

- `tlbx server add-stdio github -- npx -y @modelcontextprotocol/server-github` produces an entry that matches the example in README §4.4.
- `tlbx server add-http jira --url https://jira.example.com/mcp --auth bearer --token-env JIRA_MCP_TOKEN` produces the corresponding entry.
- Invalid input (bad URL, missing command, unknown auth type) exits non-zero with a useful message and does not modify the config.
- Duplicate name exits non-zero and does not modify the config.

## Out of scope

- Live-testing the new server (covered by `tlbx server status` + `serve`).
- Interactive wizard mode.

## Definition of done

- Acceptance criteria hold.
- Vitest tests run the commands against a temp config file and assert the resulting JSON.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M1-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
