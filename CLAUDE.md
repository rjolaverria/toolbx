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

## Library Documentation

**Always fetch up-to-date documentation before using any library, framework, or third-party API in code.** This applies to every library — including ones you think you remember well. Training-data knowledge of library APIs is frequently stale, version-skewed, or wrong, and writing against remembered APIs produces hallucinated calls that waste a fix-and-retry loop. Fetch first, then write.

This is required for:

- adding a new dependency to any `package.json`
- writing code that imports or calls into an existing dependency you have not read recently
- generating examples, snippets, or scaffolds that mention a specific library
- debugging an error that originates inside a library

Use the following sources, in order of preference:

### 1. Context7 MCP (preferred)

Context7 indexes thousands of libraries with version-specific docs and exposes them through MCP tools. If Context7 is configured in this environment, prefer it for any well-known public library.

- Set up once with `npx ctx7 setup --claude` (or `--cursor` / `--opencode`).
- Manual MCP config: server URL `https://mcp.context7.com/mcp`, optional `CONTEXT7_API_KEY` header.
- MCP tools:
  - `resolve-library-id` — resolve a free-form library name to a Context7 ID (e.g. `next.js` → `/vercel/next.js`).
  - `query-docs` (a.k.a. `get-library-docs`) — fetch docs for a Context7 ID with a specific query.
- In a prompt you can also write `use library /vercel/next.js` to pin a known ID.
- Repo: <https://github.com/upstash/context7>.

### 2. Andrew Ng's Context Hub (`chub` CLI)

Context Hub is an open-source CLI of curated, LLM-optimized API docs. Use it as the second choice, especially for libraries Context7 does not cover well.

- Install: `npm install -g @aisuite/chub`.
- Commands:
  - `chub search <query>` — find available docs (run with no args to list everything).
  - `chub get <pkg>/<topic> [--lang py|js|...]` — fetch the curated doc for that topic in the chosen language.
  - `chub annotate <pkg>/<topic> "<note>"` — save a local note when you discover a non-obvious behavior; `--list` and `--clear` manage them.
  - `chub feedback <pkg>/<topic> up|down` — flag doc quality.
- Repo: <https://github.com/andrewyng/context-hub>.

### 3. Web search / WebFetch (last resort)

Only when neither Context7 nor Context Hub has the library, fall back to `WebSearch` followed by `WebFetch` against the official docs site, the GitHub README, or the package's repo. Prefer the canonical source (the project's own docs or repo) over blog posts and tutorials, and double-check the version against the version pinned in `package.json`.

Whichever source you use, cite the specific page or doc ID you read in the commit message or PR description if it materially shaped the implementation, so reviewers can verify the API choice.

## Code Style

Prettier: single quotes, semicolons, trailing commas, 100-char print width, 2-space indent. ESLint uses `typescript-eslint` with full type-aware rules (`recommendedTypeChecked`). Config files (`.config.ts`, `.config.js`) have type-aware rules disabled since they sit outside tsconfig projects.

Always use curly braces on every block statement (`if`, `for`, `while`, etc.) — never braceless single-line bodies.

## Functions and State

Prefer pure functions. Avoid mutating in-memory state unless there is no reasonable alternative (e.g. managing an active process registry).

Use Zod only at IO boundaries: config file reads, CLI argument parsing, MCP message parsing, HTTP responses. Inside the system, pass regular typed TypeScript objects — do not re-validate data that is already typed.

Use discriminated unions (sum types) when modelling objects that have distinct combinations of fields depending on a variant. For example, `ServerConfig` with `type: 'stdio'` vs `type: 'http'` should be a union, not a single interface with optional fields.

## Tests

Write a test for every function that contains non-trivial logic. Skip tests that would only verify what TypeScript or ESLint already enforce statically (type correctness, exhaustiveness, lint rules).

## Task Workflow

All planned work for this repo is tracked in `.agents/TASKS.md` (master todo list) with one detail file per task in `.agents/tasks/<task-id>.md`. Every task is derived from `README.md` and is a deliverable.

Before starting work:

1. Open `.agents/TASKS.md`. Pick an unchecked task and read the linked task file end to end.
2. The task file states the goal, deliverables, acceptance criteria, out-of-scope items, and the explicit definition of done.
3. If the task description is wrong or out of date relative to the README, fix the task file first in its own commit, then proceed.

While working:

- Each task corresponds to its own set of commits. Do not bundle multiple unrelated tasks into one commit.
- Reference the task ID (e.g. `M2-05`) in commit messages so the audit trail is obvious.
- If you discover follow-up work that is out of scope for the current task, add it as a new task file under `.agents/tasks/` and a new entry in `.agents/TASKS.md` rather than expanding the current task.

A task is **only** complete when **all** of the following are true:

1. Every acceptance criterion in the task file is met.
2. New and existing tests pass: `pnpm test:run` is green.
3. Type checking passes: `pnpm typecheck` is green.
4. Linting passes: `pnpm lint` is green.
5. Formatting passes: `pnpm format:check` is green.
6. The pre-commit hook ran successfully on the final commit (the lint-staged hook auto-fixes ESLint and Prettier on staged files — never bypass it with `--no-verify`).
7. The work is committed (and pushed, if the branch is shared).

Only after all seven hold, flip the task's checkbox in `.agents/TASKS.md` from `[ ]` to `[x]` and append a short note pointing at the closing commit or PR. A green typecheck alone is not "done" — the manual acceptance criteria from the task file must also be verified.
