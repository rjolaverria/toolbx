# @toolbx/cli

**Toolbx** is a local MCP gateway that lets you configure your MCP servers once and connect every MCP client to one place.

Instead of repeating Jira, GitHub, Linear, Postgres, and other MCP server setup in Claude, Codex, OpenCode, and every other client, you point your clients at Toolbx and manage upstream servers in a single config file.

```txt
Claude / Codex / OpenCode / other MCP clients
        ↓
Toolbx  ← @toolbx/cli
        ↓
Jira / GitHub / Linear / custom MCP servers
```

Toolbx acts as both an **MCP server** to downstream clients and an **MCP client** to upstream servers. This package publishes the `tlbx` binary.

## Features

- Centralized config for all your MCP servers in `~/.config/toolbx/config.json`.
- Namespaced tools (`jira__search_issues`, `github__create_issue`) — no collisions across upstream servers.
- Optional progressive disclosure so agents can search and reveal tools instead of loading every tool into context.
- Supports stdio and Streamable HTTP upstream MCP servers, with bearer-token and OAuth 2.1 (PKCE + DCR) auth.
- Per-server status, auth state, tool counts, and logs.
- Import your own local TypeScript/JavaScript tools and expose them alongside proxied MCP tools.
- Copy-paste setup for Claude Code, Codex, OpenCode, and generic MCP clients.

## Quickstart

Requires **Node ≥ 22.7.0**. No global install needed — `npx` runs the published CLI:

```bash
npx -y @toolbx/cli setup
```

`tlbx setup` is the happy path. It creates `~/.config/toolbx/config.json` if it's missing, optionally walks you through adding one upstream MCP server, detects every installed MCP client on your machine (Claude Code, Codex, OpenCode), and writes a `toolbx` entry into each client's config — previewing the diff and taking a timestamped backup before any write. Re-running it is idempotent.

To install the binary persistently instead:

```bash
npm i -g @toolbx/cli
tlbx setup
```

## Adding upstream servers

Add a stdio server by passing its launch command after `--`:

```bash
tlbx server add-stdio github -- npx -y @modelcontextprotocol/server-github
```

Add a Streamable HTTP server by URL. For servers that use OAuth — like
Atlassian's remote MCP server for Jira, Confluence, and Bitbucket — `add-http`
opens your browser to authenticate and stores the tokens in your OS keychain:

```bash
tlbx server add-http atlassian --url https://mcp.atlassian.com/v1/mcp/authv2
```

Re-authenticate anytime with `tlbx auth login atlassian`.

## Common commands

| Command                                   | What it does                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `tlbx setup`                              | Guided first-run: create config, add a server, wire up clients.               |
| `tlbx serve`                              | Run Toolbx as an MCP server in the foreground.                                |
| `tlbx serve --detach`                     | Fork the HTTP gateway into the background.                                    |
| `tlbx stop`                               | Stop a background gateway.                                                    |
| `tlbx status`                             | Show the status of each configured upstream server.                           |
| `tlbx server add-stdio <name> -- <cmd>`   | Add a stdio upstream server.                                                  |
| `tlbx server add-http <name> --url <url>` | Add a Streamable HTTP upstream server.                                        |
| `tlbx server list`                        | List configured upstream servers.                                             |
| `tlbx auth login <server>`                | Authenticate (or re-authenticate) an OAuth server.                            |
| `tlbx auth status`                        | Show stored credentials and expiry.                                           |
| `tlbx tool import <path>`                 | Import a local TS/JS tool (added disabled; run `tlbx tool enable` to expose). |
| `tlbx client install <client>`            | Write the Toolbx entry into a client's config.                                |
| `tlbx config path`                        | Print the active config file location.                                        |
| `tlbx doctor`                             | Check config, environment, and local server targets (no upstream connection). |

Run `tlbx <command> --help` for the full flag list on any command.

## Configuration

Config lives at `~/.config/toolbx/config.json` on macOS and Linux, and at `%APPDATA%\Toolbx\config.json` on Windows. The location respects `XDG_CONFIG_HOME` and can be overridden with the `TOOLBX_CONFIG` environment variable. Run `tlbx config path` to print the active location.

`tlbx init` (and `tlbx setup`) write a complete, valid config file for you — including the required top-level `server`, `progressiveDisclosure`, and `namespacing` sections — so you normally don't hand-write it. You mostly edit the `servers` map; a single stdio entry looks like:

```json
"github": {
  "type": "stdio",
  "enabled": true,
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_PERSONAL_ACCESS_TOKEN}"
  }
}
```

Prefer `tlbx server add-stdio` / `add-http` to add entries — they validate the whole file with `tlbx config validate` before writing.

## Learn more

- [GitHub repository](https://github.com/rjolaverria/Toolbx) — full documentation, examples, and troubleshooting.
- [Contributing guide](https://github.com/rjolaverria/Toolbx/blob/main/CONTRIBUTING.md) — set up, build, and test Toolbx.

## License

[MIT](https://github.com/rjolaverria/Toolbx/blob/main/LICENSE) © 2026 rjolaverria
