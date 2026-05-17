# F1-08 — Client adapter framework and Claude Code adapter

**Milestone**: Phase 1 follow-up (first-run DX overhaul, foundation task)
**SPECS references**: §4.2, §4.3. This task is the foundation for the new `tlbx setup` and `tlbx client install` flow; it ships no new user-visible CLI command on its own. F1-09 adds the install command, F1-10 adds the orchestrator, F1-11 retires Claude Desktop from `client print-config`.

## Goal

Introduce a uniform `ClientAdapter` abstraction in `@toolbox/core/clients/` and ship the first adapter — Claude Code — that registers ToolBox as a user-scope stdio MCP server by editing `~/.claude.json` directly. No shelling out to `claude mcp add`. The adapter must be idempotent, atomic, and safe to re-run.

## Motivation

The first-run path today is four manual steps and the snippet-paste step is where developers stall. To collapse it to a single `tlbx setup` command we need a small, well-bounded primitive — "wire ToolBox into one MCP client" — that the orchestrator can call once per detected client and that Phase 2's Electron UI can reuse without re-implementing the file edits.

We're going with **direct file writes** for all clients (including Claude Code), rather than delegating to `claude mcp add`. Reason: the user prefers not to track Claude Code's evolving CLI subcommand surface; the `~/.claude.json` schema is the more stable contract. Concurrent-write risk is real (Claude Code can rewrite this file via `/mcp`) but containable with read-then-restate.

## Deliverables

- **`packages/core/src/clients/types.ts`** — the public types:

  ```ts
  export interface ClientAdapter {
    readonly name: 'claude' | 'codex' | 'opencode';
    detect(): Promise<DetectedClient | null>;
    install(opts: InstallOpts): Promise<InstallResult>;
  }

  export interface DetectedClient {
    readonly name: ClientAdapter['name'];
    readonly configPath: string;
  }

  export interface InstallOpts {
    readonly dryRun: boolean;
    readonly force: boolean; // overwrite a conflicting `toolbox` entry
  }

  export type InstallResult =
    | {
        ok: true;
        status: 'installed' | 'already-installed';
        configPath: string;
        backupPath?: string;
        diff: string;
      }
    | { ok: false; reason: string; hint?: string };
  ```

  Re-export from the package's public index so apps/cli can consume it.

- **`packages/core/src/clients/detect.ts`** — a pure `detectClients(): Promise<DetectedClient[]>` that probes each adapter in order (Claude Code, Codex, OpenCode for future tasks) and returns the ones whose config files exist. Honors `XDG_CONFIG_HOME` on Linux. Pure-function shape so the future Electron app can call it on a timer without side effects.

- **`packages/core/src/clients/claude.ts`** — Claude Code adapter:
  - Config path: `~/.claude.json` on POSIX, `%USERPROFILE%\.claude.json` on Windows. **Do not** read `~/.claude/settings.json` — that's a different file (Claude Code user settings, not MCP servers).
  - `detect()` returns `{ configPath }` iff the file exists. Missing file → null (not an error — Claude Code creates it on first run). **Do not parse the JSON in `detect()`**: a malformed `~/.claude.json` must still be detected so that `install()`'s parse error and recovery hint (step 2) reach the user, instead of `setup` silently reporting "Claude Code not detected".
  - `install()`:
    1. Read file, capture `mtime` and content hash.
    2. Parse JSON. If unparseable, return `{ ok: false, reason: 'config is not valid JSON', hint: 'open ~/.claude.json and fix the syntax error, then re-run' }`.
    3. Compute the merge: `mcpServers.toolbox = { type: 'stdio', command: 'npx', args: ['-y', 'tlbx', 'serve', '--stdio'], env: {} }`. (`type`, `command`, `args`, `env` are all required per Claude Code's schema — keep `args` and `env` even if empty.)
    4. Idempotency: if `mcpServers.toolbox` already exists with matching `command`/`args`/`env`/`type`, return `{ ok: true, status: 'already-installed', ... }` with an empty diff.
    5. Conflict: if it exists with different values and `force` is false, return `{ ok: false, reason: 'mcpServers.toolbox already present with different command/args', hint: 're-run with --force to overwrite' }`.
    6. `dryRun: true` returns the diff and stops here — no writes, no backup.
    7. Otherwise: write the merged content to `<configPath>.tmp.<pid>` and fsync. Then re-stat the original and compare `mtime`+size to the values captured in step 1. If they differ, delete the tmp file and abort with `{ ok: false, reason: 'Claude Code modified ~/.claude.json while we were merging', hint: 're-run `tlbx client install claude`' }` — no backup file is created. Only when the original still matches: copy the original to `<configPath>.bak.<ISO-8601>`, then `rename` the tmp file over the original (atomic on POSIX). The order is **write tmp → re-stat → backup → rename**, so a concurrent-modification abort leaves zero artifacts on disk.
    8. Return `{ ok: true, status: 'installed', configPath, backupPath, diff }`.

- **Tests** in `packages/core/src/clients/claude.test.ts`:
  - Empty `~/.claude.json` (`{}`) → adds `mcpServers.toolbox`.
  - File with unrelated `mcpServers` entries → preserves them, adds `toolbox` alongside.
  - File with existing matching `toolbox` entry → returns `already-installed`, no write.
  - File with conflicting `toolbox` entry and `force: false` → returns `ok: false`, no write.
  - File with conflicting `toolbox` entry and `force: true` → overwrites, writes backup.
  - Malformed JSON → returns `ok: false` with `hint`, no write.
  - Concurrent modification: simulate file changing between read and rename (by mutating the file inside a mocked `fs.rename`) → adapter aborts, original is untouched, no `.bak` file created.
  - `dryRun: true` → returns diff, no filesystem changes.
  - Tests use a temp HOME-equivalent directory; no real `~/.claude.json` ever touched.

- **No new CLI command** in this task. The adapter is consumed by F1-09's `tlbx client install` command. F1-08 ships the library only.

## Acceptance criteria

- A consumer can call `claudeAdapter.install({ dryRun: false, force: false })` on a fresh machine with an empty `~/.claude.json` and the resulting file contains the correct `mcpServers.toolbox` entry plus a sibling `.bak.<ISO>` of the original.
- Re-running the same call is a no-op (no second backup file, no diff).
- Tampering with the file between the read and the rename causes the adapter to abort without touching the original.
- All eight test cases above pass.
- `detect()` returns null when `~/.claude.json` is absent — no error thrown.

## Out of scope

- The `tlbx client install` CLI command (F1-09).
- The `tlbx setup` orchestrator (F1-10).
- The Codex and OpenCode adapters (F1-09).
- Changes to `tlbx client print-config` (F1-11).
- Project-scope MCP registration (i.e., editing `.mcp.json` in a repo). v1 is user-scope only.
- Migration / repair of existing malformed `~/.claude.json`.

## Definition of done

- Acceptance criteria hold.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` all pass.
- Coverage floors in root `vitest.config.ts` raised for `@toolbox/core` if the new tests meaningfully raise the captured percentage.
- Pre-commit hook ran clean; the `F1-08` checkbox in `.agents/TASKS.md` is flipped with the closing commit / PR.
