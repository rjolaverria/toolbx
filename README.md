# Toolbox Product and Engineering Plan

## Naming Rules

- **Official product name:** Toolbox
- **Short CLI alias:** `tlbx`
- Use `tlbx` only in commands, for example `npx tlbx serve`.
- Do **not** use `tlbx` in file names, config directories, package names, schemas, logs, or UI labels.

Recommended names:

```txt
Product: Toolbox
CLI command: tlbx
Config directory: ~/.config/toolbox
Package namespace: @toolbox/*
MCP server name in client configs: toolbox
```

---

# 1. Product Goal

Toolbox is a local MCP gateway/proxy that lets users configure their MCP servers once and connect multiple MCP client applications to one central server.

Instead of configuring Jira, GitHub, Linear, Postgres, filesystem, or other MCP servers separately in Claude, Codex, OpenCode, and other clients, the user configures those servers once in Toolbox.

Then MCP clients connect to Toolbox:

```txt
Claude / Codex / OpenCode / other MCP clients
        ↓
Toolbox
        ↓
Jira / GitHub / Linear / custom MCP servers / custom tools
```

Toolbox acts as both:

1. An **MCP server** to downstream client applications.
2. An **MCP client** to upstream MCP servers.

The primary user value is centralized MCP server management, centralized auth/configuration, namespaced tools, and optional progressive disclosure of tools.

---

# 2. Core Product Requirements

## 2.1 Centralized MCP Server Management

Toolbox should allow users to add, edit, remove, enable, and disable MCP servers from one place.

Supported upstream server types in Phase 1:

- stdio MCP servers
- Streamable HTTP MCP servers

Toolbox should store all server configuration in a global config file.

## 2.2 Global Config File

Use a developer-friendly cross-platform config location.

Default locations:

```txt
macOS:   ~/.config/toolbox/config.json
Linux:   ~/.config/toolbox/config.json
Windows: %APPDATA%\Toolbox\config.json
```

Also support environment override:

```bash
TOOLBOX_CONFIG=/custom/path/config.json npx tlbx serve
```

If `XDG_CONFIG_HOME` is set, respect it:

```txt
$XDG_CONFIG_HOME/toolbox/config.json
```

## 2.3 Namespaced Tools

Every tool exposed through Toolbox should be namespaced according to the upstream server it came from.

Default naming format:

```txt
<serverName>__<toolName>
```

Examples:

```txt
jira__search_issues
github__create_issue
linear__list_issues
postgres__query
```

Toolbox should internally preserve the original mapping:

```ts
{
  exposedName: "jira__search_issues",
  serverName: "jira",
  upstreamName: "search_issues"
}
```

## 2.4 Progressive Disclosure

Progressive disclosure should be configurable on/off.

When progressive disclosure is **off**:

```txt
tools/list → all enabled namespaced tools from all enabled servers
```

When progressive disclosure is **on**:

```txt
tools/list → Toolbox bootstrap tools + previously revealed tools for the current client/session
```

The goal is to avoid dumping all available tools into the model context. Instead, the agent can search for relevant tools and then reveal the ones it needs.

Bootstrap tools:

```txt
toolbox__search_tools
toolbox__reveal_tools
toolbox__hide_tools
toolbox__list_available_servers
toolbox__list_revealed_tools
```

Example flow:

```txt
User: Find the Jira ticket about the login bug.

Agent initially sees:
- toolbox__search_tools
- toolbox__reveal_tools

Agent calls:
toolbox__search_tools({ query: "jira ticket login bug" })

Toolbox returns candidates:
- jira__search_issues
- jira__get_issue
- jira__add_comment

Agent calls:
toolbox__reveal_tools({
  tools: ["jira__search_issues", "jira__get_issue"]
})

Toolbox updates that session's visible tool set.

Client refreshes tools/list.

Agent now sees:
- toolbox__search_tools
- toolbox__reveal_tools
- jira__search_issues
- jira__get_issue
```

## 2.5 Server Status and Auth Status

Toolbox should show status for every upstream MCP server.

Possible server states:

```ts
type ServerStatus =
  | 'disabled'
  | 'starting'
  | 'connected'
  | 'auth_required'
  | 'auth_expired'
  | 'error'
  | 'stopped';
```

Status should include:

- server name
- transport type
- enabled/disabled
- connection status
- auth status
- tool count
- last connected time
- last error
- logs

---

# 3. Recommended Tech Stack

## 3.1 Phase 1 Stack

Use TypeScript end-to-end for the MVP.

Recommended stack:

```txt
TypeScript
Node.js
@modelcontextprotocol/sdk
Commander or Clipanion for CLI commands
Zod for config validation
JSON config file
SQLite later for runtime cache/index/history if needed
```

Reasoning:

- The user already knows TypeScript, Express, FastMCP, and the TypeScript MCP SDK.
- The MCP proxy problem is mostly orchestration, configuration, auth, process management, and protocol routing.
- TypeScript is fastest for building both the CLI and future Electron UI.
- A separate Go/Rust/Python backend is unnecessary for the MVP.

## 3.2 Phase 2 Stack

Use Electron for the desktop UI.

Recommended stack:

```txt
Electron
React
shadcn/ui
Tailwind CSS
TypeScript
TanStack Router
TanStack Query
```

Reasoning:

- Electron gives the most predictable cross-platform desktop UI.
- React and shadcn/ui are fast for building a polished management interface.
- The Electron app can reuse the same TypeScript core package as the CLI.

## 3.3 Phase 3 Stack

Use the same TypeScript runtime for custom tools.

Recommended stack:

```txt
TypeScript / JavaScript custom tool files
JSDoc metadata parser
Zod or JSON Schema for input schemas
Node subprocesses or worker threads for execution isolation
```

---

# 4. Phase 1: TypeScript CLI and MCP Proxy

## 4.1 Phase 1 Objective

Build a CLI-first Toolbox MVP that can be run with:

```bash
npx tlbx
```

The CLI should allow users to:

1. Initialize Toolbox.
2. Add stdio MCP servers.
3. Add Streamable HTTP MCP servers.
4. Edit server configurations.
5. Store everything in the global Toolbox config file.
6. Start Toolbox as an MCP proxy server.
7. Connect Claude, Codex, OpenCode, and other MCP clients to Toolbox.
8. View upstream server connection status.
9. View auth status.
10. List and search available tools.
11. Toggle progressive disclosure on/off.
12. Expose namespaced tools.
13. Route tool calls to the correct upstream MCP server.

## 4.2 CLI Commands

Initial command surface:

```bash
npx tlbx init
npx tlbx serve
npx tlbx status
npx tlbx doctor

npx tlbx server add-stdio <name> -- <command...>
npx tlbx server add-http <name> --url <url>
npx tlbx server list
npx tlbx server status <name>
npx tlbx server enable <name>
npx tlbx server disable <name>
npx tlbx server remove <name>
npx tlbx server edit <name>
npx tlbx server inspect <name>

npx tlbx tools list
npx tlbx tools search <query>
npx tlbx tools enable <namespace/tool>
npx tlbx tools disable <namespace/tool>

npx tlbx config path
npx tlbx config edit
npx tlbx config validate
npx tlbx config set progressiveDisclosure.enabled true
npx tlbx config set progressiveDisclosure.enabled false

npx tlbx client print-config claude
npx tlbx client print-config codex
npx tlbx client print-config opencode
```

Future auth commands:

```bash
npx tlbx auth login <server>
npx tlbx auth logout <server>
npx tlbx auth status
```

## 4.3 What `client print-config` Does

`npx tlbx client print-config claude` should print the exact config snippet a user needs to paste into Claude Desktop's MCP configuration so Claude connects to Toolbox as one MCP server.

Example:

```json
{
  "mcpServers": {
    "toolbox": {
      "command": "npx",
      "args": ["-y", "tlbx", "serve", "--stdio"]
    }
  }
}
```

This gives the user a simple copy-paste setup flow.

The command should also support variants:

```bash
npx tlbx client print-config claude --stdio
npx tlbx client print-config claude --http
npx tlbx client print-config claude --json
```

## 4.4 Example Config File

```json
{
  "$schema": "https://toolbox.dev/schema/config.schema.json",
  "version": 1,
  "server": {
    "stdio": {
      "enabled": true
    },
    "http": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 7331,
      "path": "/mcp"
    }
  },
  "progressiveDisclosure": {
    "enabled": true,
    "mode": "session",
    "bootstrapTools": true,
    "autoRevealExactServerMatches": true,
    "maxSearchResults": 20
  },
  "namespacing": {
    "separator": "__",
    "format": "server__tool",
    "collisionStrategy": "error"
  },
  "servers": {
    "jira": {
      "type": "http",
      "enabled": true,
      "url": "https://jira.example.com/mcp",
      "auth": {
        "type": "bearer",
        "tokenEnv": "JIRA_MCP_TOKEN"
      },
      "timeoutMs": 60000
    },
    "github": {
      "type": "stdio",
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_PERSONAL_ACCESS_TOKEN}"
      },
      "timeoutMs": 60000
    }
  }
}
```

## 4.5 Tool Search

For the MVP, use deterministic search instead of embeddings.

Index these fields:

```txt
server name
tool name
tool title
tool description
input schema property names
input schema property descriptions
user-provided tags/categories
```

Ranking order:

1. Exact server match.
2. Exact namespace match.
3. Exact tool name match.
4. Description keyword match.
5. Input schema keyword match.
6. Fuzzy match.

Embeddings can be added later after real usage proves they are needed.

## 4.6 MCP Functionality to Support

### Must Have for MVP

```txt
initialize
notifications/initialized
ping
tools/list
tools/call
notifications/tools/list_changed
logging capture/proxy
```

### Should Have After Core Proxy Works

```txt
resources/list
resources/read
resources/templates/list
prompts/list
prompts/get
completion/complete
cancellation
progress
```

### Defer

```txt
sampling
elicitation
roots passthrough
resource subscriptions
OAuth dynamic client registration
remote multi-user auth
```

## 4.7 Phase 1 Repo Structure

```txt
toolbox/
  apps/
    cli/
      src/
        commands/
        index.ts
  packages/
    core/
      src/
        config/
        registry/
        proxy/
        disclosure/
        namespace/
        status/
        auth/
    mcp-gateway/
      src/
        downstream-server/
        upstream-client/
        transports/
    custom-tools/
      src/
        loader/
        manifest/
        sandbox/
    ui-shared/
      src/
        types/
        schemas/
  examples/
  docs/
```

Phase 1 primarily uses:

```txt
apps/cli
packages/core
packages/mcp-gateway
```

## 4.8 Phase 1 Acceptance Criteria

Phase 1 is complete when:

1. `npx tlbx init` creates a valid Toolbox config file.
2. `npx tlbx server add-stdio` works.
3. `npx tlbx server add-http` works.
4. `npx tlbx serve` exposes a valid MCP server.
5. Claude, Codex, OpenCode, or another MCP client can connect to Toolbox as one MCP server.
6. `tools/list` returns namespaced tools.
7. `tools/call` routes correctly to the upstream MCP server.
8. Progressive disclosure can be toggled on/off.
9. In progressive mode, only bootstrap tools plus revealed tools are visible.
10. Toolbox can search tools and reveal selected tools.
11. `npx tlbx status` shows server connection and auth state.
12. Config validation catches broken commands, duplicate names, invalid URLs, missing environment variables, and namespace collisions.

---

# 5. Phase 2: Electron UI

## 5.1 Phase 2 Objective

Build a desktop UI that does everything the CLI does, but with a better user experience.

The UI should use the same underlying Toolbox core package as the CLI. The Electron app should not reimplement the proxy logic.

## 5.2 Desktop Architecture

```txt
Electron Main Process
  ├─ imports @toolbox/core
  ├─ manages config
  ├─ starts/stops Toolbox proxy
  ├─ monitors server status
  └─ exposes IPC API to renderer

React Renderer
  ├─ dashboard
  ├─ server manager
  ├─ tool inventory
  ├─ auth/status screens
  ├─ progressive disclosure settings
  ├─ client setup snippets
  └─ logs
```

## 5.3 UI Screens

### Dashboard

Show:

```txt
Toolbox status
Local endpoint
Connected clients
Enabled upstream servers
Total tool count
Warnings/errors
Recent activity
```

### MCP Servers

For each server, show:

```txt
name
type: stdio/http
enabled/disabled
connection status
auth status
tool count
last connected
last error
```

Actions:

```txt
Add server
Edit server
Disable server
Remove server
Restart server
Inspect tools
Test connection
```

### Add Server Wizard

Two primary flows:

```txt
Add local stdio server
Add remote Streamable HTTP server
```

For stdio:

```txt
Name
Command
Arguments
Environment variables
Working directory
Timeout
```

For HTTP:

```txt
Name
URL
Auth type: none / bearer / OAuth
Headers
Timeout
```

### Tools

Table columns:

```txt
Toolbox name
Original server
Original upstream tool name
Description
Input schema preview
Enabled status
Revealed status
```

Actions:

```txt
Search
Reveal
Hide
Pin always visible
Disable globally
Copy tool name
```

### Progressive Disclosure

Settings:

```txt
Enabled / disabled
Session-based / global
Bootstrap tools visible
Max search results
Always reveal tools from selected servers
Pinned tools
```

### Client Setup

Generate setup snippets for:

```txt
Claude
Codex
OpenCode
Generic MCP client
```

Each setup page should provide copy-paste snippets and explain whether the setup uses stdio or HTTP.

### Logs

Show:

```txt
Connection logs
Tool calls
Auth events
Upstream errors
Client sessions
Progressive disclosure reveal/hide events
```

Filters:

```txt
server
client
tool
status
time range
```

## 5.4 Phase 2 Acceptance Criteria

Phase 2 is complete when the desktop app can:

1. Add, edit, remove, enable, and disable stdio servers.
2. Add, edit, remove, enable, and disable HTTP servers.
3. Start, stop, and restart Toolbox.
4. Show server status.
5. Show auth status.
6. Show all discovered tools.
7. Toggle progressive disclosure.
8. Search and reveal tools.
9. Generate client setup snippets.
10. Show logs and recent tool calls.
11. Use the same global config file as the CLI.

---

# 6. Phase 3: Custom JS/TS Tools

## 6.1 Phase 3 Objective

Allow users to create or import custom local tools and expose them through Toolbox alongside proxied MCP tools.

This makes Toolbox not only an MCP proxy, but a lightweight personal tool platform.

## 6.2 Custom Tool File Format

Example custom tool:

```ts
/**
 * @toolbox-tool name send_slack_summary
 * @toolbox-tool title Send Slack Summary
 * @toolbox-tool description Summarize text and send it to a configured Slack channel.
 * @toolbox-tool namespace personal
 */

import { z } from 'zod';

export const inputSchema = z.object({
  channel: z.string().describe('Slack channel ID or name'),
  summary: z.string().describe('Summary text to send'),
});

export default async function sendSlackSummary(input: { channel: string; summary: string }) {
  return {
    content: [
      {
        type: 'text',
        text: `Sent summary to ${input.channel}`,
      },
    ],
  };
}
```

Import command:

```bash
npx tlbx tool import ./send_slack_summary.ts
```

Toolbox stores the imported tool under the Toolbox config/data directory, not under any path named with the CLI alias.

Example storage path:

```txt
~/.config/toolbox/tools/personal/send_slack_summary.ts
```

Exposed tool name:

```txt
personal__send_slack_summary
```

## 6.3 Custom Tool Manifest

After import, Toolbox should generate a manifest:

```json
{
  "name": "send_slack_summary",
  "namespace": "personal",
  "exposedName": "personal__send_slack_summary",
  "title": "Send Slack Summary",
  "description": "Summarize text and send it to a configured Slack channel.",
  "entry": "tools/personal/send_slack_summary.ts",
  "runtime": "node",
  "enabled": true,
  "permissions": {
    "network": true,
    "filesystem": false,
    "env": ["SLACK_BOT_TOKEN"]
  }
}
```

## 6.4 Custom Tool CLI Commands

```bash
npx tlbx tool import ./my-tool.ts
npx tlbx tool list
npx tlbx tool inspect personal__my_tool
npx tlbx tool enable personal__my_tool
npx tlbx tool disable personal__my_tool
npx tlbx tool remove personal__my_tool
```

## 6.5 Custom Tool UI Flow

```txt
Custom Tools
  → Import Tool
  → Select .ts or .js file
  → Preview metadata
  → Preview permissions
  → Import
  → Enable
```

## 6.6 Custom Tool Security Requirements

Custom tools are arbitrary code, so Toolbox should treat them carefully.

Minimum requirements:

1. Show a permission preview before import.
2. Require explicit enablement.
3. Hide environment variables and secrets from logs.
4. Run each tool with timeout limits.
5. Add per-tool audit logs.
6. Consider worker threads or subprocess isolation.
7. Later add stronger sandboxing.

## 6.7 Phase 3 Acceptance Criteria

Phase 3 is complete when:

1. User can import a `.js` or `.ts` tool.
2. Toolbox extracts name, title, namespace, and description from JSDoc.
3. Toolbox validates the exported handler.
4. Toolbox exposes the custom tool as a namespaced MCP tool.
5. The custom tool works in Claude, Codex, OpenCode, or another MCP client through Toolbox.
6. The custom tool appears in both CLI and UI.
7. The custom tool can be enabled and disabled.
8. Tool execution is logged.
9. Tool execution has timeout and error handling.

---

# 7. Recommended Milestones

## Milestone 0: Skeleton

```txt
Monorepo
Build/test/lint setup
CLI entrypoint
Config load/save/validate
Basic logger
```

## Milestone 1: Upstream Connection Manager

```txt
Add stdio server
Add HTTP server
Connect to upstream server
Initialize upstream MCP session
Read upstream tools/list
Show status
```

## Milestone 2: Downstream Toolbox MCP Server

```txt
Expose Toolbox over stdio
Expose Toolbox over HTTP
Handle initialize
Handle tools/list
Handle tools/call
```

## Milestone 3: Proxy Routing

```txt
Namespace upstream tools
Map namespaced calls to upstream calls
Return upstream tool results
Handle timeouts
Handle errors
Handle disabled servers
```

## Milestone 4: Progressive Disclosure

```txt
Add toolbox__search_tools
Add toolbox__reveal_tools
Add toolbox__hide_tools
Add session-visible tool registry
Emit tools/list_changed when visibility changes
Add config toggle
```

## Milestone 5: Client Compatibility

```txt
Claude setup snippet
Codex setup snippet
OpenCode setup snippet
Generic MCP setup snippet
doctor command
integration tests
```

## Milestone 6: Desktop Shell

```txt
Electron app
Shared config
Server manager UI
Tool inventory UI
Progressive disclosure UI
Logs UI
```

## Milestone 7: Custom Tools

```txt
JSDoc metadata parser
Tool importer
Tool runtime
Permission preview
Custom tool registry
Expose custom tools through MCP
```

---

# 8. Opinionated MVP Scope

## Ship in First Public MVP

```txt
TypeScript CLI
stdio upstream MCP servers
Streamable HTTP upstream MCP servers
stdio downstream Toolbox MCP server
namespaced tools
tools/list
tools/call
status command
config edit/validate
progressive disclosure with search/reveal tools
client setup snippets
```

## Delay Until Later

```txt
Electron UI
custom tools
full OAuth polish
resources/prompts proxying
embeddings
multi-user remote hosting
team sync
marketplace
```

The most important early risk is not the UI. The most important risk is getting MCP proxy semantics, client compatibility, tool discovery, auth state, and process management right. Once the CLI proxy is reliable, the Electron app becomes a polished control panel over a proven core.

---

# 9. Design Principles

1. **Toolbox is the product. `tlbx` is only the command alias.**
2. **Centralize config and auth.** Users should not repeat MCP setup across clients.
3. **Prefer predictable behavior over clever behavior.**
4. **Namespacing is mandatory.** Tool collisions should be impossible or explicit.
5. **Progressive disclosure should be optional.** Power users may prefer all tools visible.
6. **CLI first, UI second.** Build the reliable core before the desktop shell.
7. **Everything should be inspectable.** Users should be able to see server status, tool mappings, auth state, and logs.
8. **Custom tools should be easy but explicit.** Importing arbitrary code should require review and enablement.
