# ToolBox Product and Engineering Plan

## Naming Rules

- **Official product name:** ToolBox
- **Short CLI alias:** `tlbx`
- Use `tlbx` only in commands, for example `npx tlbx serve`.
- Do **not** use `tlbx` in file names, config directories, package names, schemas, logs, or UI labels.

Recommended names:

```txt
Product: ToolBox
CLI command: tlbx
Config directory: ~/.config/toolbox
Package namespace: @toolbox/*
MCP server name in client configs: toolbox
```

---

# 1. Product Goal

ToolBox is a local MCP gateway/proxy that lets users configure their MCP servers once and connect multiple MCP client applications to one central server.

Instead of configuring Jira, GitHub, Linear, Postgres, filesystem, or other MCP servers separately in Claude, Codex, OpenCode, and other clients, the user configures those servers once in ToolBox.

Then MCP clients connect to ToolBox:

```txt
Claude / Codex / OpenCode / other MCP clients
        ↓
ToolBox
        ↓
Jira / GitHub / Linear / custom MCP servers / custom tools
```

ToolBox acts as both:

1. An **MCP server** to downstream client applications.
2. An **MCP client** to upstream MCP servers.

The primary user value is centralized MCP server management, centralized auth/configuration, namespaced tools, and optional progressive disclosure of tools.

---

# 2. Core Product Requirements

## 2.1 Centralized MCP Server Management

ToolBox should allow users to add, edit, remove, enable, and disable MCP servers from one place.

Supported upstream server types in Phase 1:

- stdio MCP servers
- Streamable HTTP MCP servers

ToolBox should store all server configuration in a global config file.

## 2.2 Global Config File

Use a developer-friendly cross-platform config location.

Default locations:

```txt
macOS:   ~/.config/toolbox/config.json
Linux:   ~/.config/toolbox/config.json
Windows: %APPDATA%\ToolBox\config.json
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

Every tool exposed through ToolBox should be namespaced according to the upstream server it came from.

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

ToolBox should internally preserve the original mapping:

```ts
{
  exposedName: "jira__search_issues",
  serverName: "jira",
  upstreamName: "search_issues"
}
```

### 2.3.1 Namespace collisions across proxied and custom tools

**Decision.** Custom tools (Phase 3) and proxied upstream tools share one flat exposed-name
space. A custom tool whose `<namespace>__<name>` would collide with any namespaced proxied tool
exposed by an enabled upstream server is rejected — at import time and at gateway startup. The
rule applies symmetrically: an upstream server whose name collides with an existing custom tool
namespace is rejected at `tlbx server add-*` time.

In practice this means a custom tool's `@toolbox-tool namespace` must not equal the `name` of
any configured upstream server, and vice versa.

**Alternatives considered.**

- _Auto-prefix custom tools_ (e.g. `custom__personal__send_slack_summary`): rejected because it
  changes the exposed-name format from `server__tool` and complicates the namespacing module.
- _Last-write-wins shadowing_ (e.g. custom tool overrides upstream): rejected because the
  surprise factor is high — a user adding a custom tool would silently displace a working
  upstream tool with the same name.
- _Defer the decision to Phase 3_: rejected because P3-02 already states this is an error;
  putting the rule in §2.3 makes namespacing self-consistent before custom tools land.

**Reasoning.** Namespacing is mandatory (§9, principle 4); collisions must be impossible or
explicit. Hard error at import is the only behavior that lets a user trust that `personal__foo`
always refers to the thing they think it refers to. The error message names the colliding
entity so the user can rename one side.

## 2.4 Progressive Disclosure

Progressive disclosure should be configurable on/off.

When progressive disclosure is **off**:

```txt
tools/list → all enabled namespaced tools from all enabled servers
```

When progressive disclosure is **on**:

```txt
tools/list → ToolBox bootstrap tools + previously revealed tools for the current client/session
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

ToolBox returns candidates:
- jira__search_issues
- jira__get_issue
- jira__add_comment

Agent calls:
toolbox__reveal_tools({
  tools: ["jira__search_issues", "jira__get_issue"]
})

ToolBox updates that session's visible tool set.

Client refreshes tools/list.

Agent now sees:
- toolbox__search_tools
- toolbox__reveal_tools
- jira__search_issues
- jira__get_issue
```

### 2.4.1 What "session" means for progressive disclosure

**Decision.** A "session" — the unit that owns a revealed-tool set when
`progressiveDisclosure.mode = "session"` — is one **downstream MCP transport session**:

- **stdio downstream:** one transport session lasts for the lifetime of the ToolBox process
  that the MCP client spawned. The revealed set is in-memory and dies with the process.
- **HTTP downstream:** one transport session is one Streamable HTTP MCP session as defined by
  `mcp-session-id`. The revealed set lives for the lifetime of that session id and is dropped
  when the transport closes.

Re-issuing `initialize` over an already-open transport does **not** reset the revealed set —
the visibility state is bound to the transport, not the `initialize` exchange. When
`progressiveDisclosure.mode = "global"`, all transports in the same ToolBox process share one
revealed set.

**Alternatives considered.**

- _Per-`initialize`-call scope:_ rejected because MCP clients re-initialize during reconnect,
  protocol-version negotiation, and capability refresh; tying visibility to that boundary would
  surprise users with sudden tool-list resets.
- _Per-client-process scope:_ rejected for Phase 1 — there is no reliable client identity over
  stdio (no PID handshake) and treating two HTTP requests from the same client process as one
  session would require an out-of-band identifier we don't have.
- _Persisted (disk-backed) per-client memory:_ rejected as out of scope for Phase 1; deferred
  until a multi-client identity story exists.

**Reasoning.** Binding visibility to the transport session matches what is already
implementable: the downstream `Server` instance and its transport are the only objects with a
clean creation/teardown boundary today. Phase 2 may add a longer-lived "client identity" notion
on top, but that is additive and does not require revisiting this rule.

## 2.5 Server Status and Auth Status

ToolBox should show status for every upstream MCP server.

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

Build a CLI-first ToolBox MVP that can be run with:

```bash
npx tlbx
```

The CLI should allow users to:

1. Initialize ToolBox.
2. Add stdio MCP servers.
3. Add Streamable HTTP MCP servers.
4. Edit server configurations.
5. Store everything in the global ToolBox config file.
6. Start ToolBox as an MCP proxy server.
7. Connect Claude, Codex, OpenCode, and other MCP clients to ToolBox.
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

### 4.2.1 Scope of `tlbx tools enable / disable`

**Decision.** `tlbx tools enable <name>` and `tlbx tools disable <name>` are **global and
persisted**: they write to `config.tools[<exposedName>] = { enabled: boolean }` in the ToolBox
config file. There is no per-session enable/disable.

Precedence with progressive disclosure (when it is on):

```
disabled  → never appears in tools/list and tools/call rejects, regardless of reveal state.
enabled   → eligible for inclusion in tools/list; whether it is *actually* listed still
            depends on `progressiveDisclosure.enabled` and the per-session revealed set.
```

"Disabled but revealed" is therefore not a visible state — disable trumps reveal. Hiding a
tool with `toolbox__hide_tools` only affects the current session's revealed set; it does not
write to the config and does not survive process restart.

The CLI clears the override (rather than persisting `{ enabled: true }`) when the user enables
a tool whose default is already "enabled," keeping the config minimal.

**Alternatives considered.**

- _Per-session disable in addition to global disable:_ rejected because reveal/hide already
  covers the per-session use case (hide a tool you don't want in context).
- _Reveal trumps disable (revealing un-disables):_ rejected because `disable` is the user's
  explicit "I never want this tool" signal; an agent calling `reveal_tools` should not be
  able to override it.
- _Disable hides the tool from `tools/list` but still allows `tools/call`:_ rejected; the two
  must move together so disabled tools can't be invoked by name from cached client state.

**Reasoning.** Users reach for `disable` when a tool is dangerous, noisy, or duplicates another
one. The expectation is "off means off everywhere," and the configuration must reflect that
across restarts and across all downstream sessions. Reveal/hide is the orthogonal,
context-saving knob for individual sessions.

## 4.3 What `client print-config` Does

`npx tlbx client print-config claude` should print the exact config snippet a user needs to paste into Claude Desktop's MCP configuration so Claude connects to ToolBox as one MCP server.

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

### 4.4.1 Config schema versioning and migration policy

The config carries a top-level `"version": <integer>`. Every released binary declares one
**current schema version** and a (possibly empty) list of **migratable previous versions**.

**Decision (Phase 1: only version 1 exists, so the policy is forward-looking).**

| Loaded `version`            | Behavior                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| equal to current            | Load normally.                                                                                                |
| in `migratablePrev` list    | `tlbx` refuses to start and prints `tlbx config migrate` instructions. The migration is opt-in, never silent. |
| older than `migratablePrev` | Hard-fail with a "config too old; pin an older ToolBox release or recreate via `tlbx init`" error.            |
| newer than current          | Hard-fail with "config was written by a newer ToolBox; upgrade the CLI" — never best-effort load.             |
| missing / non-integer       | Hard-fail at schema validation (already enforced by `z.literal(1)` today).                                    |

`tlbx config migrate` is the only forward path. It reads the current file, applies the chain of
migration functions from the loaded version to the binary's current version (each migration is
a pure function written in the same PR that bumps the version), writes the result to disk
**after backing up the original to `<config>.bak.<isoDate>`**, and exits non-zero if any step
fails.

Each version bump must:

1. Add a migration function and a test that runs it on the previous version's example config.
2. Update the table above with the new `current` and `migratablePrev` values.
3. Note the change in `CHANGELOG.md`.

**Alternatives considered.**

- _Best-effort forward-compatibility (drop unknown fields, fill in defaults):_ rejected.
  Silent fixes hide real config errors and let two ToolBox installations on the same machine
  disagree about what the config means.
- _Hard-fail on every mismatch, never migrate:_ rejected because it forces users to re-`init`
  and lose hand-edited settings on every breaking schema change.
- _Auto-migrate on load with no opt-in:_ rejected because a misbehaving migration could
  irreversibly mangle the user's config; an explicit `migrate` step preserves the backup and
  lets the user inspect the diff.

**Reasoning.** Schema bumps are rare but they will happen (e.g. when OAuth, sandboxing limits,
or per-client settings land). The policy splits the safe automation (read v1, write v1) from
the riskier path (rewriting a file the user might have hand-edited), and forces every bump to
ship its own migration in the same PR — so the only way to add an un-migratable change is
deliberate.

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

### 4.6.1 Auth recovery flow

ToolBox surfaces two auth-related server states (§2.5): `auth_required` and `auth_expired`.
This subsection specifies how a user moves a server out of those states in Phase 1 and how
Phase 2's UI bridges to that.

**Decision (Phase 1).**

- **Credential storage.** The Phase 1 config stores only an _environment variable name_
  (`auth.tokenEnv`) for bearer auth. The token itself lives in the user's process environment.
  ToolBox never writes the token to the config file, never writes it to disk under any other
  path, and never logs its value. No keychain integration in Phase 1.
- **Entering `auth_required`.** Set when the upstream client cannot connect because the bearer
  env var named by `auth.tokenEnv` is missing or empty at connect time. The gateway stops
  retrying that server (no backoff loop while the user fixes the env var).
- **Entering `auth_expired`.** Reserved for future OAuth flows where ToolBox can detect a
  refreshable token expiration mid-session. Phase 1 does not transition into this state; the
  type exists in `ServerStatus` so consumers don't have to be re-typed when OAuth lands.
- **Exiting either state.** The user (a) makes the credential available — for bearer, exports
  the env var in the shell that runs `tlbx serve`; (b) restarts the affected upstream session.
  In Phase 1 the supported restart paths are:

  ```bash
  npx tlbx server disable <name> && npx tlbx server enable <name>   # toggles config; takes
                                                                    # effect on next serve
  npx tlbx stop && npx tlbx serve --detach                          # restart the gateway
  ```

  There is intentionally no in-process "retry now" command in Phase 1 — the gateway has no
  way to learn that the env var changed without being restarted.

- **Phase 2 UI bridge.** P2-03 surfaces the missing `tokenEnv` name and a "How to fix"
  explanation that mirrors the CLI flow above. The UI's "Restart server" action calls into
  `@toolbox/core` to drive the same dispose-and-restart sequence; it does not introduce a
  separate credential store.

**Future auth commands.** §4.2 lists `npx tlbx auth login/logout/status` as future. When those
commands ship (alongside OAuth or a keychain backend) they will become the supported recovery
path for any non-env-var auth type, and the env-var flow above will remain valid for plain
bearer.

**Alternatives considered.**

- _Persist tokens in the ToolBox config:_ rejected. The config is plain JSON in
  `~/.config/toolbox/`, not protected, and synced through dotfile repos by many users. Putting
  secrets there is a footgun.
- _Persist tokens in an OS keychain by default:_ deferred. Keychain support is desirable but
  belongs in its own task with its own threat model — Phase 1 ships only the env-var path.
- _Auto-poll the env var and recover without restart:_ rejected. Polling `process.env` is
  cheap but the env of a long-running process is fixed at spawn; the value the user sets in
  their shell would not propagate. We would have to watch a sentinel file or shell-out to the
  user's shell rc, which is a larger scope than this section's decision.

**Reasoning.** Phase 1's job is to make the auth model predictable and Phase 2's UI a thin
shell over the CLI behavior. The env-var path keeps secrets out of ToolBox's storage entirely,
which is the conservative default; richer flows (OAuth, keychain) layer in later without
breaking the rule that ToolBox owns no plaintext credentials by default.

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

1. `npx tlbx init` creates a valid ToolBox config file.
2. `npx tlbx server add-stdio` works.
3. `npx tlbx server add-http` works.
4. `npx tlbx serve` exposes a valid MCP server.
5. Claude, Codex, OpenCode, or another MCP client can connect to ToolBox as one MCP server.
6. `tools/list` returns namespaced tools.
7. `tools/call` routes correctly to the upstream MCP server.
8. Progressive disclosure can be toggled on/off.
9. In progressive mode, only bootstrap tools plus revealed tools are visible.
10. ToolBox can search tools and reveal selected tools.
11. `npx tlbx status` shows server connection and auth state.
12. Config validation catches broken commands, duplicate names, invalid URLs, missing environment variables, and namespace collisions.

---

# 5. Phase 2: Electron UI

## 5.1 Phase 2 Objective

Build a desktop UI that does everything the CLI does, but with a better user experience.

The UI should use the same underlying ToolBox core package as the CLI. The Electron app should not reimplement the proxy logic.

## 5.2 Desktop Architecture

```txt
Electron Main Process
  ├─ imports @toolbox/core
  ├─ manages config
  ├─ starts/stops ToolBox proxy
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
ToolBox status
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
ToolBox name
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
3. Start, stop, and restart ToolBox.
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

Allow users to create or import custom local tools and expose them through ToolBox alongside proxied MCP tools.

This makes ToolBox not only an MCP proxy, but a lightweight personal tool platform.

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

ToolBox stores the imported tool under the ToolBox config/data directory, not under any path named with the CLI alias.

Example storage path:

```txt
~/.config/toolbox/tools/personal/send_slack_summary.ts
```

Exposed tool name:

```txt
personal__send_slack_summary
```

## 6.3 Custom Tool Manifest

After import, ToolBox should generate a manifest:

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

Custom tools are arbitrary code, so ToolBox should treat them carefully.

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
2. ToolBox extracts name, title, namespace, and description from JSDoc.
3. ToolBox validates the exported handler.
4. ToolBox exposes the custom tool as a namespaced MCP tool.
5. The custom tool works in Claude, Codex, OpenCode, or another MCP client through ToolBox.
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

## Milestone 2: Downstream ToolBox MCP Server

```txt
Expose ToolBox over stdio
Expose ToolBox over HTTP
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
stdio downstream ToolBox MCP server
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

1. **ToolBox is the product. `tlbx` is only the command alias.**
2. **Centralize config and auth.** Users should not repeat MCP setup across clients.
3. **Prefer predictable behavior over clever behavior.**
4. **Namespacing is mandatory.** Tool collisions should be impossible or explicit.
5. **Progressive disclosure should be optional.** Power users may prefer all tools visible.
6. **CLI first, UI second.** Build the reliable core before the desktop shell.
7. **Everything should be inspectable.** Users should be able to see server status, tool mappings, auth state, and logs.
8. **Custom tools should be easy but explicit.** Importing arbitrary code should require review and enablement.
