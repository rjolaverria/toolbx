import * as fs from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import * as path from 'node:path';

import type {
  ClientAdapter,
  ClientAdapterEnv,
  DetectedClient,
  InstallOpts,
  InstallResult,
} from './types.js';

const CLAUDE_CONFIG_FILENAME = '.claude.json';
const TOOLBOX_KEY = 'toolbox';

const TOOLBOX_ENTRY: ToolboxEntry = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'tlbx', 'serve', '--stdio'],
  env: {},
};

interface ToolboxEntry {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CreateClaudeAdapterOptions extends ClientAdapterEnv {
  /**
   * Test-only hook. Runs after the tmp file is written but before the
   * concurrent-modification re-stat. Used to simulate Claude Code rewriting
   * `~/.claude.json` mid-install. Do not use in production.
   */
  readonly afterTmpWrite?: () => Promise<void>;
}

export function createClaudeAdapter(options: CreateClaudeAdapterOptions = {}): ClientAdapter {
  const homedir = options.homedir ?? osHomedir;
  const configPath = resolveConfigPath(homedir);
  const afterTmpWrite = options.afterTmpWrite;

  return {
    name: 'claude',
    async detect(): Promise<DetectedClient | null> {
      try {
        await fs.stat(configPath);
        return { name: 'claude', configPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    async install(opts: InstallOpts): Promise<InstallResult> {
      return installClaudeMcpEntry({ configPath, opts, afterTmpWrite });
    },
  };
}

export const claudeAdapter: ClientAdapter = createClaudeAdapter();

function resolveConfigPath(homedir: () => string): string {
  return path.join(homedir(), CLAUDE_CONFIG_FILENAME);
}

interface InstallContext {
  readonly configPath: string;
  readonly opts: InstallOpts;
  readonly afterTmpWrite?: (() => Promise<void>) | undefined;
}

async function installClaudeMcpEntry(ctx: InstallContext): Promise<InstallResult> {
  const { configPath, opts } = ctx;

  let initialStat: { mtimeMs: number; size: number };
  let source: string;
  try {
    initialStat = await fs.stat(configPath);
    source = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        reason: 'Claude Code config not found',
        hint: 'launch Claude Code once to create ~/.claude.json, then re-run',
      };
    }
    throw error;
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(source) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        reason: '~/.claude.json is not a JSON object',
        hint: 'open ~/.claude.json and replace the file contents with `{}`, then re-run',
      };
    }
    parsed = raw as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      reason: '~/.claude.json is not valid JSON',
      hint: 'open ~/.claude.json and fix the syntax error, then re-run',
    };
  }

  const existingServers = readMcpServers(parsed);
  const existingToolbox = existingServers?.[TOOLBOX_KEY];

  if (existingToolbox !== undefined) {
    if (toolboxEntryMatches(existingToolbox)) {
      return {
        ok: true,
        status: 'already-installed',
        configPath,
        diff: '',
      };
    }
    if (!opts.force) {
      return {
        ok: false,
        reason: 'mcpServers.toolbox already present with different command/args',
        hint: 're-run with --force to overwrite',
      };
    }
  }

  const merged: Record<string, unknown> = { ...parsed };
  const mergedServers: Record<string, unknown> = { ...(existingServers ?? {}) };
  mergedServers[TOOLBOX_KEY] = { ...TOOLBOX_ENTRY, args: [...TOOLBOX_ENTRY.args] };
  merged.mcpServers = mergedServers;

  const nextSource = JSON.stringify(merged, null, 2) + '\n';
  const diff = formatDiff(existingToolbox, mergedServers[TOOLBOX_KEY]);

  if (opts.dryRun) {
    return {
      ok: true,
      status: 'installed',
      configPath,
      diff,
    };
  }

  const tmpPath = `${configPath}.tmp.${process.pid}`;
  try {
    const handle = await fs.open(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(nextSource, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await unlinkIfExists(tmpPath);
    throw error;
  }

  if (ctx.afterTmpWrite) {
    try {
      await ctx.afterTmpWrite();
    } catch (error) {
      await unlinkIfExists(tmpPath);
      throw error;
    }
  }

  let currentStat: { mtimeMs: number; size: number };
  try {
    currentStat = await fs.stat(configPath);
  } catch (error) {
    await unlinkIfExists(tmpPath);
    throw error;
  }
  if (currentStat.mtimeMs !== initialStat.mtimeMs || currentStat.size !== initialStat.size) {
    await unlinkIfExists(tmpPath);
    return {
      ok: false,
      reason: 'Claude Code modified ~/.claude.json while we were merging',
      hint: 're-run `tlbx client install claude`',
    };
  }

  // Atomic file replacement, two-rename style:
  //
  //   1. rename(orig → backup) — moves the verified original inode to the
  //      backup path atomically. After this, the live path is empty and the
  //      backup is decoupled from anything that happens at the live path
  //      next, so a concurrent O_TRUNC writer cannot bleed into the backup
  //      (the way it could with a shared-inode hard-link approach).
  //   2. rename(tmp → orig) — atomically lands the merged content at the
  //      live path. If step 2 fails, rollback by renaming the backup back
  //      into place so the user is not left with a missing config file.
  //
  // The unique timestamp + pid suffix on backupPath makes accidental
  // collision effectively impossible, which is the practical substitute for
  // a portable "rename, no-replace" syscall.
  const backupPath = `${configPath}.bak.${timestampForBackup()}.${process.pid}`;
  try {
    await fs.rename(configPath, backupPath);
  } catch (error) {
    await unlinkIfExists(tmpPath);
    throw error;
  }

  try {
    await fs.rename(tmpPath, configPath);
  } catch (error) {
    // Best-effort rollback: restore the original from backup so the user
    // is not left with a missing config file. We swallow the rollback
    // error because we are already on the error path; the original
    // failure is what the caller needs to see.
    try {
      await fs.rename(backupPath, configPath);
    } catch {
      // backup remains at backupPath; surface the original error below.
    }
    await unlinkIfExists(tmpPath);
    throw error;
  }

  return {
    ok: true,
    status: 'installed',
    configPath,
    backupPath,
    diff,
  };
}

function readMcpServers(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = parsed.mcpServers;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

function toolboxEntryMatches(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== TOOLBOX_ENTRY.type) return false;
  if (candidate.command !== TOOLBOX_ENTRY.command) return false;
  if (!arraysShallowEqual(candidate.args, TOOLBOX_ENTRY.args)) return false;
  if (!recordsShallowEqual(candidate.env, TOOLBOX_ENTRY.env)) return false;
  return true;
}

function arraysShallowEqual(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function recordsShallowEqual(a: unknown, b: Readonly<Record<string, string>>): boolean {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return false;
  const candidate = a as Record<string, unknown>;
  const aKeys = Object.keys(candidate);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of bKeys) {
    if (candidate[key] !== b[key]) return false;
  }
  return true;
}

function formatDiff(previous: unknown, next: unknown): string {
  const before = previous === undefined ? null : previous;
  const lines: string[] = [];
  if (before !== null) {
    lines.push('- mcpServers.toolbox = ' + JSON.stringify(before));
  }
  lines.push('+ mcpServers.toolbox = ' + JSON.stringify(next));
  return lines.join('\n');
}

function timestampForBackup(): string {
  // ISO-8601 with colons replaced so the backup is a legal filename on every
  // platform we target. Example: `2026-05-17T18-30-45-123Z`.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // best-effort cleanup
  }
}
