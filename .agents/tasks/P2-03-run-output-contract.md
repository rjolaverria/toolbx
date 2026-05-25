# P2-03 — `tlbx run` output modes and exit contract

**Milestone**: Phase 2 — CLI Tool Execution
**SPECS references**: §5.4, §5.6 (criterion 5)

## Goal

Make `tlbx run` reliable for both humans and agents by defining stable stdout, stderr, output modes, and exit behavior.

## Deliverables

- `--output <text|json|mcp>` option.
- Default output mode:
  - TTY stdout → `text`
  - non-TTY stdout → `json`
- Stdout/stderr split:
  - stdout contains only the tool result,
  - stderr contains diagnostics, daemon startup messages, warnings, and remediation hints.
- `json` output wrapper:
  - `ok`,
  - `server`,
  - `tool`,
  - `exposedName`,
  - `result` on success,
  - structured `error` on failure when the failure happens after target resolution.
- `mcp` output prints the raw MCP `CallToolResult` JSON.
- `text` output extracts text content when possible and falls back to compact JSON for non-text content.
- Exit codes are documented in the command help and tests distinguish at least usage, daemon, unknown-tool, auth, timeout, and tool-result failures.

## Acceptance criteria

- Successful text output prints no diagnostics to stdout.
- Successful JSON output is stable enough for agents to parse.
- Raw MCP output exactly preserves the daemon's `CallToolResult`.
- A tool result marked as an error exits nonzero.
- Daemon startup messages go to stderr in every output mode.

## Out of scope

- Full custom formatting templates.
- Streaming output.

## Definition of done

- Acceptance criteria hold.
- Snapshot tests cover text, JSON, MCP, TTY default, non-TTY default, stderr diagnostics, and nonzero tool-result errors.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-03 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
