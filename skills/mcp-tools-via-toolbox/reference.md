# `tlbx run` reference

Complete reference for the `tlbx run` command. The authoritative source is `tlbx run --help`; this mirrors it with the detail an agent needs to drive the command unattended.

## Synopsis

```
tlbx run [options] [target] [tool]
```

- `target` — a fully exposed tool name (`<server>__<tool>`), **or** the server name when `[tool]` is also given.
- `tool` — the upstream tool name; resolves to `<target>__<tool>`.

So `tlbx run acme create_item` and `tlbx run acme__create_item` are equivalent. The namespace separator is a double underscore (`__`); server names never contain it.

## Modes

`tlbx run` is in exactly one of three modes, decided by the flags present:

1. **Execution** — no discovery flag and a tool target is given → calls the tool.
2. **Discovery** — any of `--search`, `--list`, `--describe`, `--schema`, `--example` (mutually exclusive with each other).
3. **Usage error** — invalid combination → exit 2.

Discovery flags take **no** tool input (`--json`/`--file`/`--stdin` are rejected in discovery).

## Options

| Flag                    | Applies to            | Notes                                                                                                  |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| `--json <json>`         | execution             | Tool arguments as an inline JSON object.                                                               |
| `--file <path>`         | execution             | Read arguments as JSON from a file.                                                                    |
| `--stdin`               | execution             | Read arguments as JSON from stdin.                                                                     |
| `--output <mode>`       | execution + discovery | `text` \| `json` \| `mcp`. Default: `text` on a TTY, `json` otherwise. `mcp` is invalid for discovery. |
| `--search <query>`      | discovery             | Rank enabled tools by relevance; optional `[target]` scopes to a server.                               |
| `--list`                | discovery             | List enabled tools; optional `[target]` scopes to a server.                                            |
| `--describe`            | discovery             | Human/JSON summary of one tool: required + optional fields and an example call.                        |
| `--schema`              | discovery             | The tool's raw JSON Schema.                                                                            |
| `--example`             | discovery             | A generated JSON argument skeleton for the tool.                                                       |
| `--limit <n>`           | discovery             | Cap `--search` results. **Only** valid with `--search`; an error elsewhere.                            |
| `-c, --config <path>`   | both                  | Override the resolved config path for this run.                                                        |
| `--log-level <level>`   | both                  | Daemon log level used **only** when auto-starting.                                                     |
| `--log-format <format>` | both                  | Daemon log format used **only** when auto-starting.                                                    |

`--json`, `--file`, and `--stdin` are mutually exclusive. JSON input must parse to an **object** (not an array or scalar); otherwise exit 2. A tool whose schema declares no properties and no required fields needs no input flag.

## Output modes

### `json` (default when piped) — execution success

```json
{
  "ok": true,
  "server": "acme",
  "tool": "create_item",
  "exposedName": "acme__create_item",
  "result": { "content": [{ "type": "text", "text": "..." }] }
}
```

### `json` — execution failure

```json
{
  "ok": false,
  "server": "acme",
  "tool": "create_item",
  "exposedName": "acme__create_item",
  "error": { "kind": "auth", "message": "...", "result": {} }
}
```

`error.kind` is one of: `usage`, `daemon`, `unknown_tool`, `auth`, `timeout`, `tool_error`. `error.result` is present only when the failure carried an MCP tool result.

### `text`

Just the joined text content blocks of the result (falls back to compact JSON for non-text content). Nothing on stderr for a success.

### `mcp`

The raw MCP `CallToolResult` JSON, verbatim. Not supported in discovery mode.

**In every mode, human-facing diagnostics and remediation hints go to stderr; stdout carries only the result/envelope.**

The JSON envelope is emitted only for failures that occur **after** the target is resolved and the daemon is contacted (`daemon`, `unknown_tool`, `auth`, `timeout`, `tool_error`, and the post-resolution "requires input" usage error). **Preflight** errors — an unknown `--output`, `--limit` without `--search`, mutually-exclusive input/discovery flags, malformed JSON, or a missing target — are written to stderr and exit non-zero with **empty stdout**. Branch on the exit code first; never assume stdout holds a parseable envelope.

## Exit codes

| Code | Constant     | Meaning                                                                                 |
| ---- | ------------ | --------------------------------------------------------------------------------------- |
| 0    | success      | The tool ran and returned a non-error result.                                           |
| 1    | tool error   | The tool reported an error, or an upstream failure with no more specific code.          |
| 2    | usage        | Bad flags, invalid/mutually-exclusive input, malformed JSON, or missing required input. |
| 3    | daemon       | Config load, daemon startup/readiness, or connection failure.                           |
| 4    | unknown tool | The resolved tool is not exposed — unknown name, or disabled tool/server.               |
| 5    | auth         | The target server needs authentication, or its credentials expired.                     |
| 6    | timeout      | The upstream tool call exceeded its configured timeout.                                 |

## Remediation by exit code

- **2 — usage/input.** Regenerate a valid skeleton: `tlbx run <server> <tool> --example > input.json`, edit, then `--file input.json`. Check that you passed exactly one of `--json`/`--file`/`--stdin` and that JSON is an object.
- **3 — daemon.** Transient startup/connection issue. Retry once. If it persists, surface the stderr message to the user; do not loop.
- **4 — unknown/disabled.** Re-run `tlbx run --list` (or `--search`) to get the correct exposed name — the stderr message offers "did you mean" suggestions. If the tool/server is disabled, the message names the exact command (`tlbx tools enable <name>` or `tlbx server enable <name>`); that's a user decision, so ask before enabling.
- **5 — auth.** **Do not retry blindly.** Two cases, and the daemon's stderr tells you which:
  - OAuth server → the user runs `tlbx auth login <server>`, then you retry.
  - Bearer-token server → the daemon reads the token from its environment **only at startup**. The user must export the variable, then `tlbx stop`, then you retry. A running daemon will not pick up a newly exported variable.
- **6 — timeout.** Retry once, or narrow the request (smaller page size, tighter query). Persistent timeouts are a user/server problem to report.

## Discovery output shapes

- `--list` / `--search` (text): a table with columns `EXPOSED  SERVER  TOOL  ENABLED  DESCRIPTION` (list) or `EXPOSED  SERVER  TOOL  SCORE  MATCHED` (search).
- `--list` / `--search` (json): an array of row objects.
- `--describe` (json): `{ exposedName, serverName, upstreamName, title?, description?, required[], optional[], example: { arguments, command } }` where each field is `{ name, type?, description? }`.
- `--schema` (json): the raw input schema object.
- `--example` (json): a generated skeleton object; fields the generator can't resolve (unions, untyped) become the string `"<unsupported>"` and must be hand-filled.

## Notes on tool visibility

The daemon's control-plane `tools/list` returns the **full enabled tool set** regardless of progressive disclosure — so discovery sees every enabled tool, not just a revealed subset. A server in `auth_required` contributes **no** tools to the listing, yet its tools are still callable: the call reaches the daemon, which then returns the authoritative result (exit 4 if truly unknown, exit 5 if auth is the blocker). So a tool missing from `--list` is not proof it can't be called — try it and read the exit code.
