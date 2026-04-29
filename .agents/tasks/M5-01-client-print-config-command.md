# M5-01 — `tlbx client print-config` command

**Milestone**: 5 — Client Compatibility & UX Polish
**README references**: §4.2, §4.3

## Goal

Print copy-paste MCP setup snippets for popular clients. This is the primary onboarding flow.

## Deliverables

- `apps/cli/src/commands/client-print-config.ts` registering `tlbx client print-config <client>`.
- Supported clients: `claude`, `codex`, `opencode`, `generic`.
- Flags: `--stdio` (default), `--http`, `--json`.
- For each client, render the snippet that points the client at this Toolbox instance:
  - stdio → `npx -y tlbx serve --stdio` invocation.
  - http → the URL formed from `server.http.host`, `server.http.port`, `server.http.path` in config.
- `--json` prints the exact JSON the user pastes; the default prints a friendly explanation followed by a fenced JSON block.
- `claude` snippet matches the example in README §4.3 for the stdio variant.

## Acceptance criteria

- The Claude stdio snippet exactly matches README §4.3.
- The HTTP snippets reference the configured host/port/path, not hard-coded defaults.
- Unknown clients exit non-zero with a list of supported clients.
- `--json` output parses with `JSON.parse` cleanly (snapshot-tested).

## Out of scope

- Auto-installing the snippet into the client's config file.
- Version-pinning `tlbx` in the snippet (let users manage that).

## Definition of done

- Acceptance criteria hold.
- Snapshot tests cover each client × transport combination.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M5-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
