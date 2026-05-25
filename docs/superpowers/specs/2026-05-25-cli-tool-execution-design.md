# CLI Tool Execution Design

## Context

ToolBox no longer needs a near-term Electron or TUI layer. The next product layer should let
users, scripts, and agents invoke configured ToolBox tools as CLI commands.

The detailed product spec lives in `.agents/SPECS.md` §5, and the implementation backlog lives
in `.agents/TASKS.md` Phase 2.

## Decisions

1. Phase 2 is `tlbx run`, not an interactive UI.
2. JSON is the canonical input format.
3. `tlbx run` always executes through a ToolBox daemon.
4. If no daemon is running for the resolved config path, `tlbx run` auto-starts one.
5. Auto-started daemons stay running until `tlbx stop`.
6. The command uses the daemon's local MCP HTTP endpoint and the existing `tools/call` path.
7. Discovery is provided by `--list`, `--search`, `--describe`, `--schema`, and `--example`.
8. Output supports `text`, `json`, and raw MCP result modes.
9. `tlbx run` never opens a browser implicitly; OAuth remediation points to `tlbx auth login`.
10. Progressive disclosure does not apply to `tlbx run`. It is a local control surface whose
    caller already named an exact tool, so it sees and can call every enabled tool regardless of
    the revealed set. A local-only control marker on the daemon connection turns disclosure off
    for `tlbx run` sessions while real MCP clients on the same daemon keep it. Global
    enable/disable still applies.
11. `tlbx run` always uses an HTTP endpoint. An auto-started daemon forces a loopback HTTP
    listener even when `server.http.enabled=false`; that flag only governs whether an explicit
    `tlbx serve` exposes HTTP to external MCP clients.
12. Concurrent cold-start is serialized by the OS socket bind, not a lock file: clean stale
    state, probe-and-reuse a healthy daemon, bind before publishing state, real readiness probe.
    ToolBox keeps the configured fixed port (MCP clients use a fixed URL) and resolves the race
    by probe-and-reuse on that port rather than per-daemon port discovery. A healthy ToolBox
    daemon for a different resolved config on the same host/port is a collision, not a reusable
    daemon.
13. Phase 2 does not add a separate daemon-local auth handshake for `tlbx run`. The endpoint is
    loopback-only, the control marker identifies a local control-plane caller, and upstream
    bearer/OAuth auth remains enforced by the gateway path.

## Command Shape

```bash
tlbx run <server> <tool> --json '{...}'
tlbx run <server> <tool> --file input.json
tlbx run <server> <tool> --stdin
tlbx run <server> --list
tlbx run --search issue
tlbx run <server> <tool> --describe
tlbx run <server> <tool> --schema
tlbx run <server> <tool> --example
```

The command also accepts fully exposed names:

```bash
tlbx run github__create_issue --json '{...}'
```

## Runtime Shape

```txt
tlbx run
  -> resolve config
  -> ensure config-specific daemon is running
  -> connect to local Streamable HTTP MCP endpoint
  -> resolve/list/describe tools through MCP
  -> call tools/call with parsed JSON arguments
  -> render stdout/stderr according to output mode
```

This keeps MCP clients and `tlbx run` on one execution path.

## Scope

In scope:

- daemon auto-start and reuse
- JSON/file/stdin input
- text/json/mcp output
- discovery commands
- disclosure-free execution via a local control marker
- auth/error remediation
- daemon-backed integration tests

Out of scope:

- interactive UI/TUI
- direct-to-upstream execution bypassing the daemon
- remote daemon execution
- implicit OAuth browser login from `tlbx run`
- custom-tool compatibility, which belongs to the custom tool implementation phase
- custom tool runtime implementation
