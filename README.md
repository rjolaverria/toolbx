# ToolBox

ToolBox is a local MCP gateway that lets you configure your MCP servers once and connect every MCP client to one place.

Instead of repeating Jira, GitHub, Linear, Postgres, and other MCP server setup in Claude, Codex, OpenCode, and every other client, you point your clients at ToolBox and manage upstream servers in a single config file.

```txt
Claude / Codex / OpenCode / other MCP clients
        ↓
ToolBox  ← this repo
        ↓
Jira / GitHub / Linear / custom MCP servers
```

ToolBox acts as both an **MCP server** to downstream clients and an **MCP client** to upstream servers. The CLI binary is `tlbx`; zero-install `npx` examples use the package target `@toolbox/cli`.

## Features

- Centralized config for all your MCP servers in `~/.config/toolbox/config.json`.
- Namespaced tools (`jira__search_issues`, `github__create_issue`) — no collisions across upstream servers.
- Optional progressive disclosure so agents can search and reveal tools instead of loading every tool into context.
- Supports stdio and Streamable HTTP upstream MCP servers.
- Per-server status, auth state, tool counts, and logs.
- Copy-paste setup snippets for Claude, Codex, OpenCode, and generic MCP clients.

## Getting Started

> ToolBox is under active development. The CLI surface below is the target shape — see [`.agents/SPECS.md`](./.agents/SPECS.md) and [`.agents/TASKS.md`](./.agents/TASKS.md) for what is implemented today.

One command, run anywhere:

```bash
npx -y @toolbox/cli setup
```

> `@toolbox/cli` is the npm package target used by zero-install examples. For local
> development, use the workspace-built `tlbx` binary.

`tlbx setup` is the happy path. It creates `~/.config/toolbox/config.json` if it's missing, walks you through adding one upstream MCP server (optional), detects every installed MCP client on your machine — Claude Code, Codex, OpenCode — and writes a `toolbox` entry into each one's config file with a timestamped backup. You confirm once, the diffs are previewed before any write, and the next launch of those clients spawns the gateway on demand over stdio.

```text
$ npx -y @toolbox/cli setup
✓ Created config at ~/.config/toolbox/config.json
Detected MCP clients:
  • Claude Code  (~/.claude.json)
  • Codex        (~/.codex/config.toml)

Add an upstream MCP server now? [Y/n] n

Claude Code:
  + mcpServers.toolbox = {"type":"stdio","command":"npx","args":["-y","@toolbox/cli","serve","--stdio"],"env":{}}

Codex:
  + [mcp_servers.toolbox]
  +   command = "npx"
  +   args = ["-y", "@toolbox/cli", "serve", "--stdio"]

Wire ToolBox into Claude Code, Codex? [Y/n] y
  ✓ Claude Code: wrote ~/.claude.json (backup ~/.claude.json.bak.…)
  ✓ Codex: wrote ~/.codex/config.toml (backup ~/.codex/config.toml.bak.…)

✓ All set. Restart Claude Code, Codex to pick up the new server.
Add more upstream servers anytime:  tlbx server add-stdio <name> -- <cmd>
```

Useful flags: `-y/--yes` skips every confirm (good for scripts), `--no-server` skips the upstream-server prompt entirely, and `--client <name>` scopes wiring to a single client (repeatable). Re-running `tlbx setup` is idempotent — it detects existing `toolbox` entries and does not create a second backup.

### Advanced / scripting

For CI, agent loops, or anyone who wants to drive each step manually, the original four-step flow is still supported:

```bash
# Initialize the global config
npx -y @toolbox/cli init

# Add an upstream MCP server
npx -y @toolbox/cli server add-stdio github -- npx -y @modelcontextprotocol/server-github
npx -y @toolbox/cli server add-http jira --url https://jira.example.com/mcp

# Start ToolBox as an MCP server (foreground)
npx -y @toolbox/cli serve

# Or fork the HTTP gateway into the background and return to the shell prompt
npx -y @toolbox/cli serve --detach

# Stop a background gateway
npx -y @toolbox/cli stop

# Install the ToolBox entry into one client's config file
npx -y @toolbox/cli client install claude

# Or print a config snippet to paste into ~/.claude.json yourself
npx -y @toolbox/cli client print-config claude
```

### OAuth HTTP servers

For HTTP MCP servers that advertise OAuth, `server add-http` opens the browser and stores tokens
before writing the server entry:

```bash
npx -y @toolbox/cli server add-http github --url https://api.githubcopilot.com/mcp/
# Browser opens; authenticate; ToolBox stores the OAuth tokens.
npx -y @toolbox/cli auth status
```

When a server later reports expired credentials, re-authenticate with:

```bash
npx -y @toolbox/cli auth login github
```

## Configuration

Config lives at `~/.config/toolbox/config.json` by default. The location respects `XDG_CONFIG_HOME` and can be overridden with the `TOOLBOX_CONFIG` environment variable.

A minimal config looks like:

```json
{
  "version": 1,
  "servers": {
    "github": {
      "type": "stdio",
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

See [`.agents/SPECS.md`](./.agents/SPECS.md) §4.4 for the full schema.

## Repository Layout

This is a pnpm + Turborepo monorepo.

```txt
apps/cli                  — Commander CLI, produces the tlbx binary
packages/core             — config, registry, proxy, disclosure, namespacing, auth
packages/mcp-gateway      — MCP protocol layer (downstream server + upstream client)
```

## Development

Requires Node ≥ 22 and pnpm ≥ 10.

```bash
pnpm install
pnpm build         # build all packages (Turbo-ordered)
pnpm typecheck
pnpm lint
pnpm test          # vitest in watch mode
pnpm test:run      # one-shot test run
```

## Documentation

- [`.agents/SPECS.md`](./.agents/SPECS.md) — full product and engineering spec (goals, requirements, milestones, acceptance criteria).
- [`.agents/TASKS.md`](./.agents/TASKS.md) — master task list, with one detail file per task in [`.agents/tasks/`](./.agents/tasks/).
- [`CLAUDE.md`](./CLAUDE.md) — guidance for AI coding agents working on this repo.

## License

TBD.
