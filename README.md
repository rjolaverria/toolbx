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

ToolBox acts as both an **MCP server** to downstream clients and an **MCP client** to upstream servers. The CLI binary is `tlbx`.

## Features

- Centralized config for all your MCP servers in `~/.config/toolbox/config.json`.
- Namespaced tools (`jira__search_issues`, `github__create_issue`) — no collisions across upstream servers.
- Optional progressive disclosure so agents can search and reveal tools instead of loading every tool into context.
- Supports stdio and Streamable HTTP upstream MCP servers.
- Per-server status, auth state, tool counts, and logs.
- Copy-paste setup snippets for Claude, Codex, OpenCode, and generic MCP clients.

## Getting Started

> ToolBox is under active development. The CLI surface below is the target shape — see [`.agents/SPECS.md`](./.agents/SPECS.md) and [`.agents/TASKS.md`](./.agents/TASKS.md) for what is implemented today.

```bash
# Initialize the global config
npx tlbx init

# Add an upstream MCP server
npx tlbx server add-stdio github -- npx -y @modelcontextprotocol/server-github
npx tlbx server add-http jira --url https://jira.example.com/mcp

# Start ToolBox as an MCP server
npx tlbx serve

# Print a config snippet to paste into your MCP client
npx tlbx client print-config claude
```

Add the snippet to your MCP client's configuration and ToolBox will appear as a single MCP server exposing every namespaced tool from your upstream servers.

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
