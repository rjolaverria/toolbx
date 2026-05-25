# ToolBox Product and Engineering Plan

## Naming Rules

- **Official product name:** ToolBox
- **Short CLI alias:** `tlbx`
- **npm package target:** `@toolbox/cli`
- Use `tlbx` for installed/local binary command examples. Use `npx -y @toolbox/cli ...`
  for zero-install npm examples and generated MCP client config so `npx` does not resolve the
  unrelated public `tlbx` package.
- Do **not** use `tlbx` in file names, config directories, package names, schemas, logs, or UI labels.

Recommended names:

```txt
Product: ToolBox
CLI command: tlbx
Config directory: ~/.config/toolbox
Package namespace: @toolbox/*
npx package target: @toolbox/cli
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
TOOLBOX_CONFIG=/custom/path/config.json npx -y @toolbox/cli serve
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
space. Reservation is scoped to **any configured upstream server**, not only enabled ones —
disabled servers still hold their namespace so toggling `enabled` can never introduce a
collision. Concretely:

- A custom tool is rejected at import time if its `@toolbox-tool namespace` equals the `name`
  of any entry in `config.servers` (regardless of that server's `enabled` flag), or if
  `<namespace>__<name>` matches any tool currently exposed by an enabled upstream server. The
  same check runs at gateway startup as a defense against hand-edited config.
- An upstream server is rejected at `tlbx server add-*` time if its name equals the namespace
  of any imported custom tool.

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

Progressive disclosure applies only to MCP-client transport sessions. The `tlbx run` control
surface is exempt and always sees the full enabled tool set — see §5.3.

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
- TypeScript is fastest for building both the CLI and the daemon-backed `tlbx run` surface.
- A separate Go/Rust/Python backend is unnecessary for the MVP.

## 3.2 Phase 2 Stack

Use TypeScript for a daemon-backed CLI tool execution surface.

Recommended stack:

```txt
TypeScript
Node.js
Commander or Clipanion for CLI commands
@modelcontextprotocol/sdk MCP client over local Streamable HTTP
Shared ToolBox daemon/runtime
JSON input/output renderers
```

Reasoning:

- `tlbx run` gives users, scripts, and agents a stable shell interface for invoking configured tools.
- Daemon-backed execution reuses warm upstream sessions and the same routing behavior as MCP clients.
- JSON is the natural input format for agents and maps directly to MCP `tools/call` arguments.
- A separate UI layer is unnecessary until the CLI execution and daemon lifecycle are proven.

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
npx -y @toolbox/cli
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
npx -y @toolbox/cli init
npx -y @toolbox/cli setup
npx -y @toolbox/cli serve
npx -y @toolbox/cli status
npx -y @toolbox/cli doctor

npx -y @toolbox/cli server add-stdio <name> -- <command...>
npx -y @toolbox/cli server add-http <name> --url <url>
npx -y @toolbox/cli server list
npx -y @toolbox/cli server status <name>
npx -y @toolbox/cli server enable <name>
npx -y @toolbox/cli server disable <name>
npx -y @toolbox/cli server remove <name>
npx -y @toolbox/cli server edit <name>
npx -y @toolbox/cli server inspect <name>

npx -y @toolbox/cli tools list
npx -y @toolbox/cli tools search <query>
npx -y @toolbox/cli tools enable <namespace/tool>
npx -y @toolbox/cli tools disable <namespace/tool>

npx -y @toolbox/cli config path
npx -y @toolbox/cli config edit
npx -y @toolbox/cli config validate
npx -y @toolbox/cli config set progressiveDisclosure.enabled true
npx -y @toolbox/cli config set progressiveDisclosure.enabled false

npx -y @toolbox/cli client install <claude|codex|opencode>
npx -y @toolbox/cli client print-config claude
npx -y @toolbox/cli client print-config codex
npx -y @toolbox/cli client print-config opencode
```

`tlbx setup` is the recommended first-run command. It composes `init`, an optional `server add-stdio` prompt, and `client install` for every detected MCP client so a new user reaches a working ToolBox in one step. `init` and the individual commands remain available for scripting and CI.

`tlbx client install <client>` writes the ToolBox MCP server entry directly into the named client's config file (atomic write with a timestamped backup). It is the preferred wiring mechanism; `client print-config` remains as a manual-paste fallback.

Upstream auth (OAuth) commands:

```bash
npx -y @toolbox/cli auth login <server>
npx -y @toolbox/cli auth logout <server>
npx -y @toolbox/cli auth status
npx -y @toolbox/cli auth refresh <server>
```

These manage OAuth credentials for upstream HTTP MCP servers (see §4.6.2). `add-http` invokes the same login flow automatically when a probe detects an OAuth challenge, so `auth login` is primarily used for re-authentication after expiry or for switching identities.

Phase 2 adds daemon-backed tool execution:

```bash
npx -y @toolbox/cli run <server> <tool> --json '{...}'
npx -y @toolbox/cli run <server> <tool> --file input.json
npx -y @toolbox/cli run <server> <tool> --stdin
npx -y @toolbox/cli run <server> --list
npx -y @toolbox/cli run --search <query>
npx -y @toolbox/cli run <server> <tool> --describe
npx -y @toolbox/cli run <server> <tool> --schema
npx -y @toolbox/cli run <server> <tool> --example
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

`npx -y @toolbox/cli client print-config claude` prints the exact config snippet a user needs to paste into **Claude Code**'s user-scope MCP config (`~/.claude.json` on POSIX, `%USERPROFILE%\.claude.json` on Windows) so Claude Code connects to ToolBox as one MCP server. The `claude` keyword targets Claude Code, not Claude Desktop — Desktop is not supported by ToolBox in Phase 1.

Most users should reach for `tlbx client install claude` instead — it writes the same snippet into the file directly (atomic write with a backup). `print-config` exists as a manual-paste fallback and as the documentation source for the snippet shape.

Example snippet (the JSON block that gets merged into the top-level `mcpServers` object in `~/.claude.json`):

```json
{
  "mcpServers": {
    "toolbox": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@toolbox/cli", "serve", "--stdio"],
      "env": {}
    }
  }
}
```

All four fields (`type`, `command`, `args`, `env`) are required by Claude Code's schema; keep `args` and `env` present even when empty.

The command also supports:

```bash
npx -y @toolbox/cli client print-config claude --stdio
npx -y @toolbox/cli client print-config claude --http
npx -y @toolbox/cli client print-config claude --json
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
  "auth": {
    "storage": { "type": "keychain" }
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
    },
    "github-copilot": {
      "type": "http",
      "enabled": true,
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": { "type": "oauth" },
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
**after backing up the original to `<config>.bak.<yyyyMMddTHHmmssZ>`** (a filesystem-safe
basic-ISO-8601 timestamp; `:` is intentionally omitted because it is illegal in Windows
filenames), and exits non-zero if any step
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
remote multi-user auth
```

(OAuth 2.1 with dynamic client registration is no longer deferred — see §4.6.2.)

### 4.6.1 Auth recovery flow

ToolBox surfaces two auth-related server states (§2.5): `auth_required` and `auth_expired`.
This subsection specifies how a user moves a server out of those states in Phase 1 and how
Phase 2's `tlbx run` command reports those states.

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
  the env var in the shell that runs `tlbx serve`; (b) restarts the gateway so the new
  environment is picked up. In Phase 1 the only supported recovery path is a full gateway
  restart:

  ```bash
  npx -y @toolbox/cli stop && npx -y @toolbox/cli serve --detach   # restart the gateway with the updated env
  ```

  `tlbx server disable && tlbx server enable` only edits the config file and does **not**
  recover a running gateway on its own; that pair is for permanently turning a server off or
  back on between runs. There is intentionally no in-process "retry now" command in Phase 1 —
  the gateway has no way to learn that the env var changed without being restarted.

- **Phase 2 `tlbx run` bridge.** A daemon-backed `tlbx run` call surfaces the same
  remediation text as the MCP tool-call error. For bearer auth, missing `tokenEnv` errors
  explain that the user must export the variable in the environment that starts the daemon,
  then run `tlbx stop` so the next `tlbx run` auto-starts a fresh daemon with the new
  environment. For OAuth, `tlbx run` reports `tlbx auth login <server>` and exits nonzero.
  It never launches a browser implicitly; browser flows remain explicit foreground auth
  commands.

**OAuth auth recovery.** OAuth-based upstream servers follow §4.6.2's flow instead: the user
runs `npx -y @toolbox/cli auth login <server>` and the gateway picks up the new token on the next
upstream call without needing a restart. The env-var bearer path described in this subsection
remains the supported recovery path for `auth.type === 'bearer'` servers.

**Alternatives considered.**

- _Persist tokens in the ToolBox config:_ rejected. The config is plain JSON in
  `~/.config/toolbox/`, not protected, and synced through dotfile repos by many users. Putting
  secrets there is a footgun.
- _Auto-poll the env var and recover without restart:_ rejected. Polling `process.env` is
  cheap but the env of a long-running process is fixed at spawn; the value the user sets in
  their shell would not propagate. We would have to watch a sentinel file or shell-out to the
  user's shell rc, which is a larger scope than this section's decision.

**Reasoning.** Bearer-with-env-var is the conservative default — ToolBox stores nothing on
behalf of the user, so config files can be checked into dotfile repos without leaking secrets.
OAuth (§4.6.2) layers in alongside it without changing this property: tokens for OAuth servers
live in the OS keychain, not in ToolBox's config file.

### 4.6.2 Upstream OAuth 2.1 auth

ToolBox supports OAuth 2.1 with PKCE and Dynamic Client Registration as a first-class upstream
auth type, alongside the bearer-with-env-var path in §4.6.1.

**Decisions.**

- **Trigger.** `npx -y @toolbox/cli server add-http <name> --url <url>` (no `--auth` flag) probes the URL
  with an unauthenticated request. If the response carries an MCP OAuth challenge
  (`WWW-Authenticate: Bearer resource_metadata=...` per MCP 2025-06-18), ToolBox automatically
  opens a browser and runs the authorization-code flow with PKCE. The server entry is written
  to `config.json` **only if** the flow completes successfully — there is no half-authenticated
  state. Explicit `--auth oauth | bearer | none` short-circuits the probe.

- **Library.** ToolBox uses `@modelcontextprotocol/sdk`'s `client/auth` module for metadata
  discovery (RFC 8414), Dynamic Client Registration (RFC 7591), PKCE (RFC 7636), code
  exchange, and token refresh. ToolBox owns only the storage backend, the local loopback
  callback server, and the CLI orchestration. See §4.6.2 alternatives for why we don't
  roll our own.

- **Token storage.** OAuth tokens (access and refresh) and the DCR-issued `clientInformation`
  live in the **OS keychain** — never in `config.json`, never in any plain file. Service name
  `dev.toolbox.cli`, account `oauth:<server-name>`. Access happens through a small `TokenStore`
  interface so a file-backed or encrypted-file backend can be added later without changing
  callers; the interface is the only contract the rest of the codebase sees.

  Keychain access uses `@napi-rs/keyring`, loaded by dynamic `import()` inside the keychain
  backend only — never at module top level — so future non-keychain backends pay no native
  module cost. If no working secret service is available (e.g. headless Linux without
  libsecret), ToolBox fails loudly with a diagnostic from `tlbx doctor`; there is no silent
  fallback. Keychain is the only Phase 1 backend.

- **Identity scoping.** One OAuth identity per server name in Phase 1. The keychain account
  format reserves space for `oauth:<server-name>:<identity>` so a future multi-account feature
  is additive.

- **Re-auth.** When refresh fails mid-session (refresh token expired or revoked), the upstream
  session transitions to `auth_expired`. Any in-flight or subsequent tool call against that
  server returns a structured error message instructing the user to run `tlbx auth login
<server>` in a terminal. The gateway then picks up the new tokens automatically on its next
  upstream call — no restart, no IPC. The CLI's `auth login` command does not signal any
  running gateway; recovery is driven by the next call attempt re-reading the keychain.

- **Browser flow ownership.** A browser is only opened from foreground CLI commands the user
  invokes themselves — `tlbx auth login <server>` and `tlbx server add-http <name> --url <url>`
  when the probe detects an OAuth challenge. The stdio-spawned gateway and any background or
  long-running ToolBox process never opens a browser on its own. This keeps the security model
  clear (no spawned MCP server child can social-engineer a browser tab) and avoids the awkward
  UX of an unexpected browser window appearing during an agent conversation.

- **Refresh policy.** Lazy: when the gateway gets a 401 from an upstream, it calls the SDK's
  refresh helper once and retries the original call once. On refresh success the user sees no
  failure; on refresh failure the session transitions to `auth_expired` per the recovery flow
  above. There is no proactive background refresh — token expiry is handled on the call path
  it affects.

- **Atomicity.** No partially-authenticated state is ever observable. `tlbx server add-http`
  writes the server entry only after the OAuth flow completes; `tlbx auth login` writes tokens
  only after the full exchange completes; Ctrl-C at any point leaves both the keychain and
  `config.json` unchanged. `tlbx doctor` cross-checks `TokenStore.list()` against
  `config.servers` and offers `--fix` to prune orphan keychain entries (safe — recoverable via
  re-login).

**Alternatives considered.**

- _Roll our own OAuth client:_ rejected. The SDK already implements RFC 8414 / 7591 / 6749 /
  7636 correctly and is maintained by the spec authors; reimplementing them is security-
  sensitive surface area for no architectural gain.
- _Hybrid (SDK for refresh, custom orchestrator for login):_ rejected. Two parallel
  implementations of the same OAuth flow to keep in sync, justified only by UX customizations
  (callback HTML, error wording) that are not yet differentiating. Revisit if specific UX
  limitations surface during implementation.
- _Plain-file token storage with 0600 perms:_ deferred. The `TokenStore` interface
  accommodates it as a future backend; Phase 1 ships keychain-only because the existing
  bearer-with-env-var path (§4.6.1) already covers users who don't want a system keychain.
- _Spawned gateway opens the browser on `auth_expired`:_ rejected. Adds an unexpected
  browser-tab event during an agent conversation, and creates a foothold where any compromised
  upstream server can trigger a browser open during a tool call.
- _MCP elicitation-based re-auth prompt:_ deferred. The elicitation feature exists in the
  protocol but client support is uneven. Revisit when Claude Code, Codex, and OpenCode all
  support it.

**Reasoning.** OAuth lives in the same product space as bearer-env-var (§4.6.1): ToolBox keeps
zero plaintext credentials in any user-visible file. The keychain is the most conservative
storage choice that doesn't require the user to manage their own env vars. Atomicity and the
"only the CLI opens browsers" rule are both about predictability — the user should never have
to reason about what state ToolBox is in after a partial failure, and should never be
surprised by a browser tab they didn't trigger.

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

1. `npx -y @toolbox/cli init` creates a valid ToolBox config file.
2. `npx -y @toolbox/cli server add-stdio` works.
3. `npx -y @toolbox/cli server add-http` works.
4. `npx -y @toolbox/cli serve` exposes a valid MCP server.
5. Claude, Codex, OpenCode, or another MCP client can connect to ToolBox as one MCP server.
6. `tools/list` returns namespaced tools.
7. `tools/call` routes correctly to the upstream MCP server.
8. Progressive disclosure can be toggled on/off.
9. In progressive mode, only bootstrap tools plus revealed tools are visible.
10. ToolBox can search tools and reveal selected tools.
11. `npx -y @toolbox/cli status` shows server connection and auth state.
12. Config validation catches broken commands, duplicate names, invalid URLs, missing environment variables, and namespace collisions.

---

# 5. Phase 2: CLI Tool Execution

## 5.1 Phase 2 Objective

Expose configured ToolBox tools as CLI commands so users, scripts, and MCP clients with shell
access can invoke tools without speaking MCP directly.

The primary command is `tlbx run`. In Phase 2 it supports proxied upstream MCP tools. The
human-facing CLI remains the configuration and debugging surface; `tlbx run` is optimized for
deterministic agent and script execution.

## 5.2 `tlbx run` Command Surface

Canonical execution uses JSON input:

```bash
npx -y @toolbox/cli run <server> <tool> --json '{...}'
npx -y @toolbox/cli run <server> <tool> --file input.json
npx -y @toolbox/cli run <server> <tool> --stdin
```

`<server> <tool>` resolves to the exposed MCP name `<server>__<tool>`. For scripting, the fully
exposed name is also accepted:

```bash
npx -y @toolbox/cli run github create_issue --json '{"title":"Bug"}'
npx -y @toolbox/cli run github__create_issue --json '{"title":"Bug"}'
```

The three input modes are mutually exclusive. Tools with an empty input schema may omit all
three input modes; otherwise `tlbx run` requires one of them. JSON is parsed once at the CLI
boundary and forwarded as the `arguments` object for MCP `tools/call`.

Discovery commands:

```bash
npx -y @toolbox/cli run --search issue
npx -y @toolbox/cli run github --list
npx -y @toolbox/cli run github --search issue
npx -y @toolbox/cli run github create_issue --describe
npx -y @toolbox/cli run github create_issue --schema
npx -y @toolbox/cli run github create_issue --example
```

Discovery must work without requiring the user to manually start `tlbx serve`. Because
disclosure does not apply to `tlbx run` (§5.3), `--list` and `--search` operate over all
**enabled** tools for the selected scope regardless of the revealed set — they never collapse to
just the bootstrap tools. `--list` prints the tools exposed for the selected server. `--search`
uses the same ranking as `toolbox__search_tools`. `--describe` prints the title, description, required fields, optional
fields, and an example command. `--schema` prints the raw input schema as JSON. `--example`
prints a generated JSON input skeleton that can be redirected to a file and edited.

## 5.3 Daemon-Backed Runtime

`tlbx run` always executes through the ToolBox daemon, not through a separate direct-to-upstream
code path.

```txt
tlbx run
  ├─ resolve config path
  ├─ check the config-specific serve-daemon state file (clean up if stale)
  ├─ probe the endpoint; if a healthy daemon answers, reuse it
  ├─ else start `tlbx serve --detach` with HTTP forced on (loopback)
  │    (a concurrent starter that loses the bind reuses the winner)
  ├─ poll the MCP endpoint until ready
  ├─ connect to the daemon's local Streamable HTTP MCP endpoint
  ├─ resolve/list/describe tools through MCP
  ├─ call tools/call with the parsed JSON arguments
  └─ render the result for stdout
```

An auto-started daemon stays running until `tlbx stop`. There is no idle timeout in Phase 2.
This is intentional: `tlbx run` is expected to be called repeatedly by agents and scripts, so
warm upstream sessions are part of the product behavior.

The daemon state is config-specific. A `tlbx run --config <path>` invocation only reuses a
daemon started for that same resolved config path. Stale state files are cleaned up before a new
daemon is started. Config isolation is bounded by the daemon endpoint: if a healthy ToolBox daemon
for a different resolved config is already bound to the same host and port, `tlbx run` fails with a
clear config/port collision message rather than reusing it. A second config gets its own daemon
only when it resolves to a different endpoint.

The daemon's HTTP endpoint is local-only. `tlbx run` does not expose a remote execution surface
and does not bypass the existing server/tool enablement, auth, timeout, or namespacing rules.
There is no separate downstream daemon-auth mechanism in Phase 2: the daemon endpoint remains
loopback-only, and `tlbx run` authenticates to ToolBox by being a local control-plane caller with
the §5.3 marker. Upstream bearer/OAuth credentials are still enforced by the gateway when the
target tool reaches its upstream server.

**`tlbx run` always uses an HTTP endpoint, regardless of `server.http.enabled`.** `tlbx run`
reaches the daemon over the local Streamable HTTP MCP transport, so it needs an HTTP listener
even for configs whose owner only wired up stdio. When `tlbx run` auto-starts a daemon it
therefore forces a loopback HTTP listener on the configured (or default) host and port, even if
`server.http.enabled` is `false`. `server.http.enabled` governs only whether an explicitly
invoked `tlbx serve` exposes HTTP to external MCP clients; it never blocks `tlbx run`'s own
transport. Because the listener is loopback-only (§4 binds HTTP to `127.0.0.1`/`::1`/`localhost`)
and lives only because the user invoked `tlbx run`, this exposes nothing beyond localhost, and
`tlbx stop` ends it.

**Concurrent cold-start is serialized by the socket bind, not a lock file.** Agents fan out
parallel `tlbx run` calls, so two invocations can both observe "no daemon" and both try to start
one. ToolBox resolves this with the OS socket bind rather than a separate lock file:

- The OS listener bind is the mutual-exclusion primitive. Only one process can bind the
  configured loopback port; the kernel enforces single-ownership.
- Before binding, the starter cleans up stale/zombie state — a `serve` state file whose recorded
  pid is no longer alive is removed.
- Before deciding to spawn, and again when a bind loses the race (port already in use), the
  helper probes the endpoint: if a healthy ToolBox daemon for this config is already answering,
  it is reused; if the port is held by a ToolBox daemon for another config or by a foreign process,
  `tlbx run` fails with a clear message.
- The daemon binds its listener before publishing its state file, so a concurrent invocation
  cannot observe a half-started daemon and tear it down as a zombie.
- Readiness is confirmed with a real HTTP probe against the MCP endpoint, not a fixed startup
  delay.

ToolBox keeps the daemon on the configured fixed port rather than an OS-assigned one: real MCP
clients (Claude, Codex, OpenCode) are configured with a fixed endpoint URL and must be able to
find the shared daemon. The race is therefore resolved by probe-and-reuse on the fixed port
rather than by per-daemon port discovery.

**Progressive disclosure does not apply to `tlbx run`.** Disclosure exists to protect the
context window of an MCP client that is browsing `tools/list`; `tlbx run` is a local control
surface whose caller has already named an exact tool, so there is nothing to protect. `tlbx run`
sees and can call every **enabled** tool regardless of the revealed set, even when
`progressiveDisclosure.enabled=true` in config.

This is achieved with a local control-plane marker rather than a daemon-wide flag: `tlbx run`
connects to the loopback endpoint with a control marker (a header/token the daemon only honors
on loopback). For marked sessions the daemon skips disclosure entirely — `tools/list` returns
all enabled tools and `tools/call` skips the revealed-set check. Unmarked sessions (real MCP
clients such as Claude, Codex, OpenCode) keep disclosure exactly as configured. Disclosure
behavior therefore never depends on who started the daemon. Global `tlbx tools enable / disable`
still applies to both kinds of session: a disabled tool is not callable from `tlbx run`.

## 5.4 Output and Exit Contract

`tlbx run` supports explicit output modes:

```bash
npx -y @toolbox/cli run github create_issue --json '{...}' --output text
npx -y @toolbox/cli run github create_issue --json '{...}' --output json
npx -y @toolbox/cli run github create_issue --json '{...}' --output mcp
```

Defaults:

- TTY stdout defaults to `text`.
- Non-TTY stdout defaults to `json`.
- `stdout` contains only the tool result.
- `stderr` contains diagnostics, daemon startup messages, warnings, and remediation hints.
- Exit code `0` means the tool call completed successfully.
- Nonzero exit codes cover usage errors, invalid JSON, config errors, daemon startup/readiness
  failures, unknown tools, disabled tools, auth failures, timeouts, and tool-result errors.

`json` output is a stable wrapper for agents:

```json
{
  "ok": true,
  "server": "github",
  "tool": "create_issue",
  "exposedName": "github__create_issue",
  "result": {
    "content": [{ "type": "text", "text": "Created issue #123" }]
  }
}
```

`mcp` output prints the raw MCP `CallToolResult` JSON. `text` output extracts text content where
possible and falls back to a compact JSON rendering for non-text content.

## 5.5 Error and Auth Behavior

`tlbx run` should fail loudly and give actionable remediation:

- Unknown server or tool: show nearby matches from `tlbx run --search`.
- Invalid JSON: point to the parse error and recommend `--example > input.json`.
- Schema/argument rejection from upstream: print the upstream error without hiding details.
- Disabled server or tool: name the command that re-enables it.
- Missing bearer env var: explain that the variable must be present when the daemon starts,
  then recommend exporting the variable and running `tlbx stop` before retrying.
- OAuth required or expired: recommend `tlbx auth login <server>`.
- Daemon startup failure: point to `tlbx doctor` and the daemon log path.

`tlbx run` never launches a browser implicitly. Browser-based OAuth remains owned by explicit
foreground commands such as `tlbx auth login <server>` and `tlbx server add-http`.

## 5.6 Phase 2 Acceptance Criteria

Phase 2 is complete when:

1. `npx -y @toolbox/cli run <server> <tool> --json '{...}'` starts the daemon when needed and calls a tool.
2. Repeated `tlbx run` calls reuse the same config-specific daemon until `tlbx stop`.
3. `--json`, `--file`, and `--stdin` input modes work and are mutually exclusive.
4. Fully exposed names like `github__create_issue` work in addition to `<server> <tool>`.
5. `--output text`, `--output json`, and `--output mcp` are implemented with the stdout/stderr contract above.
6. `--list`, `--search`, `--describe`, `--schema`, and `--example` support tool discovery.
7. `tlbx run` honors disabled servers/tools, namespacing, auth states, and timeouts consistently with MCP `tools/call`, while applying the §5.3 progressive-disclosure exemption only to marked `tlbx run` sessions.
8. Auth failures produce actionable remediation and never open a browser implicitly.
9. The daemon startup path handles stale state files, readiness timeouts, HTTP-disabled configs, same-config concurrent cold-starts, and same-port different-config collisions without orphaning processes.
10. Integration tests cover at least one real stdio upstream fixture, one HTTP upstream fixture, HTTP-disabled config startup, and same-config concurrent cold-start through the daemon-backed `tlbx run` path.

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
npx -y @toolbox/cli tool import ./send_slack_summary.ts
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
npx -y @toolbox/cli tool import ./my-tool.ts
npx -y @toolbox/cli tool list
npx -y @toolbox/cli tool inspect personal__my_tool
npx -y @toolbox/cli tool enable personal__my_tool
npx -y @toolbox/cli tool disable personal__my_tool
npx -y @toolbox/cli tool remove personal__my_tool
```

## 6.5 Custom Tool CLI Flow

```txt
Custom Tools
  → Import Tool
  → Select .ts or .js file via `tlbx tool import`
  → Preview metadata
  → Preview permissions
  → Import
  → Enable
  → Discover with `tlbx run <namespace> --list`
  → Execute with `tlbx run <namespace> <tool> --json ...`
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
6. The custom tool is callable through `tlbx run <namespace> <tool> --json ...`.
7. The custom tool appears in `tlbx tool list`, `tlbx tools list`, and `tlbx run` discovery.
8. The custom tool can be enabled and disabled.
9. Tool execution is logged.
10. Tool execution has timeout and error handling.

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

## Milestone 6: CLI Tool Execution

```txt
tlbx run command
Daemon auto-start and reuse
JSON/file/stdin input modes
Text/JSON/MCP output modes
List/search/describe/schema/example discovery
Daemon-backed integration tests
```

## Milestone 7: Custom Tools

```txt
JSDoc metadata parser
Tool importer
Tool runtime
Permission preview
Custom tool registry
Expose custom tools through MCP
Expose custom tools through tlbx run
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
interactive UI/TUI
custom tools
full OAuth polish
resources/prompts proxying
embeddings
multi-user remote hosting
team sync
marketplace
```

The most important early risk is not an interactive UI. The most important risk is getting MCP proxy semantics, client compatibility, tool discovery, auth state, and process management right. Once the CLI proxy is reliable, `tlbx run` becomes the bridge that lets agents and scripts use the configured tool surface without speaking MCP directly.

---

# 9. Design Principles

1. **ToolBox is the product. `tlbx` is only the command alias.**
2. **Centralize config and auth.** Users should not repeat MCP setup across clients.
3. **Prefer predictable behavior over clever behavior.**
4. **Namespacing is mandatory.** Tool collisions should be impossible or explicit.
5. **Progressive disclosure should be optional.** Power users may prefer all tools visible.
6. **CLI first, UI later.** Build reliable command and agent workflows before any interactive UI layer.
7. **Everything should be inspectable.** Users should be able to see server status, tool mappings, auth state, and logs.
8. **Custom tools should be easy but explicit.** Importing arbitrary code should require review and enablement.
