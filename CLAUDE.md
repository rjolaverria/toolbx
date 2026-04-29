# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Toolbox is a local MCP gateway/proxy. It sits between MCP clients (Claude, Codex, OpenCode) and upstream MCP servers (Jira, GitHub, Linear, etc.), letting users configure all their MCP servers once in one place instead of repeating setup per client.

```
MCP Clients (Claude / Codex / OpenCode)
        ↓
Toolbox  ← this repo
        ↓
Upstream MCP Servers (Jira / GitHub / Linear / custom)
```

The CLI binary is `tlbx` (invoked as `npx tlbx`). The product name is **Toolbox**. Use `tlbx` only in CLI commands — not in file names, config dirs, package names, schemas, or UI labels.

## Commands

All commands run from the repo root. Turbo handles cross-package build ordering automatically.

```bash
pnpm build          # compile all packages (tsc per package, Turbo-ordered)
pnpm typecheck      # type-check all packages without emitting
pnpm lint           # ESLint across all packages
pnpm lint:fix       # ESLint with auto-fix
pnpm format         # Prettier write
pnpm format:check   # Prettier check (used in CI)
pnpm test           # Vitest in watch mode (workspace-aware)
pnpm test:run       # Vitest run once via Turbo (CI-style)
pnpm coverage       # Vitest with V8 coverage report
```

Run tests for a single package by filtering:

```bash
pnpm vitest --project cli
pnpm vitest --project core
pnpm vitest --project mcp-gateway
```

The pre-commit hook runs `lint-staged`, which auto-fixes ESLint and Prettier on staged files.

## Monorepo Architecture

The repo uses pnpm workspaces + Turborepo. Build order is enforced by Turbo's `dependsOn: ["^build"]` — packages must build before the apps that import them.

```
apps/cli          (@toolbox/cli)          — Commander CLI, produces the tlbx binary
packages/core     (@toolbox/core)         — config, registry, proxy logic, disclosure, namespacing, auth
packages/mcp-gateway (@toolbox/mcp-gateway) — MCP protocol layer (upstream client + downstream server)
```

**`@toolbox/core`** is the shared heart of the system. It will also be imported by the future Electron desktop app (Phase 2), so it must not depend on CLI-specific concerns.

**`@toolbox/mcp-gateway`** wraps `@modelcontextprotocol/sdk` and implements Toolbox as both an MCP server (for downstream clients) and an MCP client (for upstream servers). It depends on `@toolbox/core`.

**`apps/cli`** wires Commander commands to `@toolbox/core`. It does not depend on `@toolbox/mcp-gateway` directly — gateway logic is called through core.

## TypeScript Configuration

All packages extend `tsconfig.base.json`, which enforces:

- `"module": "NodeNext"` and `"moduleResolution": "NodeNext"` — all imports must use explicit `.js` extensions (even for `.ts` source files)
- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`
- ESM throughout (`"type": "module"` in every `package.json`)

Each package uses `composite: true` for TypeScript project references.

## Key Product Conventions

**Tool namespacing** — every tool exposed through Toolbox is prefixed with its server name and a double-underscore separator:

```
jira__search_issues
github__create_issue
```

The internal mapping preserves `{ exposedName, serverName, upstreamName }`. Never expose raw upstream tool names.

**Config file location** — `~/.config/toolbox/config.json` (respects `XDG_CONFIG_HOME` and `TOOLBOX_CONFIG` env override). Config is validated with Zod.

**Progressive disclosure** — when enabled, `tools/list` returns only bootstrap tools (`toolbox__search_tools`, `toolbox__reveal_tools`, etc.) plus previously revealed tools for the current session. When disabled, all enabled namespaced tools are returned. This is configurable and optional.

**Bootstrap tools** (used when progressive disclosure is on):
- `toolbox__search_tools`
- `toolbox__reveal_tools`
- `toolbox__hide_tools`
- `toolbox__list_available_servers`
- `toolbox__list_revealed_tools`

**Upstream server types** — Phase 1 supports `stdio` and Streamable HTTP (`http`). Each server has a `ServerStatus` that is one of: `disabled | starting | connected | auth_required | auth_expired | error | stopped`.

## Code Style

Prettier: single quotes, semicolons, trailing commas, 100-char print width, 2-space indent. ESLint uses `typescript-eslint` with full type-aware rules (`recommendedTypeChecked`). Config files (`.config.ts`, `.config.js`) have type-aware rules disabled since they sit outside tsconfig projects.
