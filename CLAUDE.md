# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

ToolBox is a local MCP gateway/proxy. It sits between MCP clients (Claude, Codex, OpenCode) and upstream MCP servers (Jira, GitHub, Linear, etc.), letting users configure all their MCP servers once in one place instead of repeating setup per client.

```
MCP Clients (Claude / Codex / OpenCode)
        ↓
ToolBox  ← this repo
        ↓
Upstream MCP Servers (Jira / GitHub / Linear / custom)
```

The CLI binary is `tlbx` (invoked as `npx tlbx`). The product name is **ToolBox**. Use `tlbx` only in CLI commands — not in file names, config dirs, package names, schemas, or UI labels.

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

**`@toolbox/mcp-gateway`** wraps `@modelcontextprotocol/sdk` and implements ToolBox as both an MCP server (for downstream clients) and an MCP client (for upstream servers). It depends on `@toolbox/core`.

**`apps/cli`** wires Commander commands to `@toolbox/core`. It does not depend on `@toolbox/mcp-gateway` directly — gateway logic is called through core.

## TypeScript Configuration

All packages extend `tsconfig.base.json`, which enforces:

- `"module": "NodeNext"` and `"moduleResolution": "NodeNext"` — all imports must use explicit `.js` extensions (even for `.ts` source files)
- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`
- ESM throughout (`"type": "module"` in every `package.json`)

Each package uses `composite: true` for TypeScript project references.

## Key Product Conventions

**Tool namespacing** — every tool exposed through ToolBox is prefixed with its server name and a double-underscore separator:

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

**Before writing code that calls a library, fetch up-to-date documentation for it.** Training-data knowledge of library APIs is frequently stale or version-skewed, and writing against remembered APIs produces hallucinated calls that waste a fix-and-retry loop.

### When to fetch

Required:

- adding a new dependency to any `package.json`
- writing code that imports or calls into an existing dependency you have not already read in the current session
- generating examples, snippets, or scaffolds that mention a specific library
- debugging an error that originates inside a library

Exempt — training-data knowledge is reliable enough; skip the fetch unless behaviour is suspect:

- the Node.js standard library (`node:fs`, `path`, etc.)
- existing in-repo usage patterns — if `commander.option(...)` is already wired up the same way elsewhere, follow that pattern
- trivial well-known calls (`JSON.parse`, `Array.from`, etc.)

Always reconcile what you fetch against the version pinned in `package.json` / `pnpm-lock.yaml`. If the docs describe a newer API than the installed version, downgrade your code to match the installed version, or upgrade the dependency in a separate, intentional commit.

### Sources, in order of preference

The repo does not auto-install these. Confirm availability before using each one and fall through to the next when a source isn't wired up.

#### 1. Context7 MCP

Context7 indexes thousands of libraries with version-specific docs and exposes them through MCP tools.

- One-time setup (run by a human, not the agent): `npx ctx7 setup --claude` (or `--cursor` / `--opencode`). Manual MCP config: server URL `https://mcp.context7.com/mcp`, optional `CONTEXT7_API_KEY` header.
- MCP tools (per `@upstash/context7-mcp@2.x`):
  - `resolve-library-id` — resolve a free-form library name to a Context7 ID (e.g. `next.js` → `/vercel/next.js`).
  - `query-docs` — fetch docs for a Context7 ID. Pin a version with `/org/project/version` when the installed version matters.
- In a prompt you can also write `use library /vercel/next.js` to pin a known ID.
- Repo: <https://github.com/upstash/context7>.

#### 2. Andrew Ng's Context Hub (`chub` CLI)

Curated, LLM-optimized API docs. Use when Context7 does not cover the library well.

- Install: `npm install -g @aisuite/chub`.
- Commands:
  - `chub search <query>` — find available docs (run with no args to list everything).
  - `chub get <pkg>/<topic> [--lang py|js|...]` — fetch the curated doc for that topic in the chosen language.
  - `chub annotate <pkg>/<topic> "<note>"` — save a local note when you discover a non-obvious behavior; `--list` and `--clear` manage them.
  - `chub feedback <pkg>/<topic> up|down` — flag doc quality.
- Repo: <https://github.com/andrewyng/context-hub>.

#### 3. WebSearch / WebFetch

When neither of the above has the library, fall back to `WebSearch` followed by `WebFetch` against the canonical source — the project's own docs site or repo, not blog posts or tutorials.

#### 4. Local `node_modules` (offline / sandboxed fallback)

If all three network sources are unavailable, read the installed copy directly. This guarantees the docs match the installed version exactly.

- `node_modules/<pkg>/README.md`
- `node_modules/<pkg>/**/*.d.ts` for the typed surface
- the package's `package.json` `exports` field for entry points

### Citing your source

If a fetched doc materially shaped the implementation — you copied an API shape, picked between two options based on what the docs said, or worked around a documented gotcha — cite the specific page or doc ID in the commit message or PR description so reviewers can verify the call. Routine confirmation lookups (e.g. "yes, `commander.option` still takes a flag string") don't need citation.

This rule is convention, not enforced by tooling. Treat the citation as part of "done" when it applies.

## Code Style

Prettier: single quotes, semicolons, trailing commas, 100-char print width, 2-space indent. ESLint uses `typescript-eslint` with full type-aware rules (`recommendedTypeChecked`). Config files (`.config.ts`, `.config.js`) have type-aware rules disabled since they sit outside tsconfig projects.

Always use curly braces on every block statement (`if`, `for`, `while`, etc.) — never braceless single-line bodies.

Do not reference PR review comments, reviewers, or review threads inside code comments (e.g. "addresses Copilot's review", "per the PR feedback"). PR-review context belongs in the commit message or PR thread reply, not in the source — it rots and leaks process noise into the codebase. Code comments should explain the code on its own terms.

## Functions and State

Prefer pure functions. Avoid mutating in-memory state unless there is no reasonable alternative (e.g. managing an active process registry).

Use Zod only at IO boundaries: config file reads, CLI argument parsing, MCP message parsing, HTTP responses. Inside the system, pass regular typed TypeScript objects — do not re-validate data that is already typed.

Use discriminated unions (sum types) when modelling objects that have distinct combinations of fields depending on a variant. For example, `ServerConfig` with `type: 'stdio'` vs `type: 'http'` should be a union, not a single interface with optional fields.

## Tests

Write a test for every function that contains non-trivial logic. Skip tests that would only verify what TypeScript or ESLint already enforce statically (type correctness, exhaustiveness, lint rules).

## Task Workflow

All planned work for this repo is tracked in `.agents/TASKS.md` (master todo list) with one detail file per task in `.agents/tasks/<task-id>.md`. Every task is derived from `.agents/SPECS.md` and is a deliverable.

Before starting work:

1. Open `.agents/TASKS.md`. Pick an unchecked task and read the linked task file end to end.
2. The task file states the goal, deliverables, acceptance criteria, out-of-scope items, and the explicit definition of done.
3. If the task description is wrong or out of date relative to `.agents/SPECS.md`, fix the task file first in its own commit, then proceed.

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

## PR Review Comments

Always reply to PR review comments after addressing them. After making the change (or deciding not to), post a reply on the comment thread that says what you did — e.g. the commit SHA that fixed it, or why you pushed back. Do not silently resolve threads; reviewers should be able to see the response without having to diff the branch themselves. If a comment can't be acted on or you disagree, still reply with the reasoning.
