# Toolbx

Toolbx is a local MCP gateway that lets you configure your MCP servers once and connect every MCP client to one place.

Instead of repeating Jira, GitHub, Linear, Postgres, and other MCP server setup in Claude, Codex, OpenCode, and every other client, you point your clients at Toolbx and manage upstream servers in a single config file.

```txt
Claude / Codex / OpenCode / other MCP clients
        ↓
Toolbx  ← this repo
        ↓
Jira / GitHub / Linear / custom MCP servers
```

Toolbx acts as both an **MCP server** to downstream clients and an **MCP client** to upstream servers. The CLI binary is `tlbx`; zero-install `npx` examples use the package target `@toolbx/cli`.

## Features

- Centralized config for all your MCP servers in `~/.config/toolbx/config.json`.
- Namespaced tools (`jira__search_issues`, `github__create_issue`) — no collisions across upstream servers.
- Optional progressive disclosure so agents can search and reveal tools instead of loading every tool into context.
- Supports stdio and Streamable HTTP upstream MCP servers.
- Per-server status, auth state, tool counts, and logs.
- Copy-paste setup snippets for Claude, Codex, OpenCode, and generic MCP clients.

## Getting Started

Requires **Node ≥ 22.7.0**. No global install needed — `npx` runs the published CLI:

```bash
npx -y @toolbx/cli setup
```

> `@toolbx/cli` is the published npm package; its binary is `tlbx`. For local
> development of Toolbx itself, use the workspace-built `tlbx` binary (see
> [Development](#development)).

`tlbx setup` is the happy path. It creates `~/.config/toolbx/config.json` if it's missing, walks you through adding one upstream MCP server (optional), detects every installed MCP client on your machine — Claude Code, Codex, OpenCode — and writes a `toolbx` entry into each one's config file with a timestamped backup. You confirm once, the diffs are previewed before any write, and the next launch of those clients spawns the gateway on demand over stdio.

```text
$ npx -y @toolbx/cli setup
✓ Created config at ~/.config/toolbx/config.json
Detected MCP clients:
  • Claude Code  (~/.claude.json)
  • Codex        (~/.codex/config.toml)

Add an upstream MCP server now? [Y/n] n

Claude Code:
  + mcpServers.toolbx = {"type":"stdio","command":"npx","args":["-y","@toolbx/cli","serve","--stdio"],"env":{}}

Codex:
  + [mcp_servers.toolbx]
  +   command = "npx"
  +   args = ["-y", "@toolbx/cli", "serve", "--stdio"]

Wire Toolbx into Claude Code, Codex? [Y/n] y
  ✓ Claude Code: wrote ~/.claude.json (backup ~/.claude.json.bak.…)
  ✓ Codex: wrote ~/.codex/config.toml (backup ~/.codex/config.toml.bak.…)

✓ All set. Restart Claude Code, Codex to pick up the new server.
Add more upstream servers anytime:  tlbx server add-stdio <name> -- <cmd>
```

Useful flags: `-y/--yes` skips every confirm (good for scripts), `--no-server` skips the upstream-server prompt entirely, and `--client <name>` scopes wiring to a single client (repeatable). Re-running `tlbx setup` is idempotent — it detects existing `toolbx` entries and does not create a second backup.

### Advanced / scripting

For CI, agent loops, or anyone who wants to drive each step manually, the original four-step flow is still supported:

```bash
# Initialize the global config
npx -y @toolbx/cli init

# Add an upstream MCP server
npx -y @toolbx/cli server add-stdio github -- npx -y @modelcontextprotocol/server-github
npx -y @toolbx/cli server add-http jira --url https://jira.example.com/mcp

# Start Toolbx as an MCP server (foreground)
npx -y @toolbx/cli serve

# Or fork the HTTP gateway into the background and return to the shell prompt
npx -y @toolbx/cli serve --detach

# Stop a background gateway
npx -y @toolbx/cli stop

# Install the Toolbx entry into one client's config file
npx -y @toolbx/cli client install claude

# Or print a config snippet to paste into ~/.claude.json yourself
npx -y @toolbx/cli client print-config claude
```

### OAuth HTTP servers

For HTTP MCP servers that advertise OAuth, `server add-http` opens the browser and stores tokens
before writing the server entry:

```bash
npx -y @toolbx/cli server add-http github --url https://api.githubcopilot.com/mcp/
# Browser opens; authenticate; Toolbx stores the OAuth tokens.
npx -y @toolbx/cli auth status
```

When a server later reports expired credentials, re-authenticate with:

```bash
npx -y @toolbx/cli auth login github
```

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

## Repository Layout

This is a pnpm + Turborepo monorepo.

```txt
apps/cli                  — Commander CLI, produces the tlbx binary
packages/core             — config, registry, proxy, disclosure, namespacing, auth
packages/mcp-gateway      — MCP protocol layer (downstream server + upstream client)
```

## Troubleshooting

- **`tlbx: command not found` after `npx`** — `npx -y @toolbx/cli <command>` runs
  without installing. To get a persistent `tlbx`, `npm i -g @toolbx/cli`.
- **Node version** — Toolbx requires Node ≥ 22.7.0. Check with `node -v`.
- **Where's my config / logs?** — `tlbx config path` prints the active config
  location; `tlbx doctor` reports environment and per-server health.
- **Secure token storage (OAuth)** — tokens are stored in your OS keychain via the
  optional `@napi-rs/keyring` native module, keyed per user (shared across configs,
  which is why `tlbx doctor` may list tokens for servers not in the current config).
  If the native module is unavailable on your platform, Toolbx falls back to a
  non-keychain token store automatically — nothing crashes, tokens just live
  outside the OS keychain.
- **A server shows `auth_required` / `auth_expired`** — run `tlbx auth login <server>`.

## Development

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Requires Node ≥ 22 and pnpm ≥ 10.

```bash
pnpm install
pnpm build         # build all packages (Turbo-ordered)
pnpm typecheck
pnpm lint
pnpm test          # vitest in watch mode
pnpm test:run      # one-shot test run
```

## Documentation

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to set up, build, and test Toolbx.
- [`RELEASING.md`](./RELEASING.md) — how releases are cut and published to npm.
- [`CLAUDE.md`](./CLAUDE.md) — guidance for AI coding agents working on this repo.

## License

[MIT](./LICENSE) © 2026 rjolaverria
