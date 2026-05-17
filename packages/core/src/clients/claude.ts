import { createHash, randomUUID } from 'node:crypto';
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

export type CreateClaudeAdapterOptions = ClientAdapterEnv;

/**
 * Hooks reserved for tests inside this module. Not part of the public
 * `CreateClaudeAdapterOptions` because downstream consumers must not depend
 * on these — they exist only to make the concurrent-write races inside
 * `installClaudeMcpEntry` reachable from vitest. The public factory routes
 * through `createClaudeAdapter`, which always passes an empty hooks object.
 */
export interface InternalInstallHooks {
  readonly afterTmpWrite?: () => Promise<void>;
  readonly afterMoveOriginalToBackup?: () => Promise<void>;
}

export function createClaudeAdapter(options: CreateClaudeAdapterOptions = {}): ClientAdapter {
  return createClaudeAdapterInternal(options, {});
}

export function createClaudeAdapterInternal(
  options: CreateClaudeAdapterOptions,
  hooks: InternalInstallHooks,
): ClientAdapter {
  const homedir = options.homedir ?? osHomedir;
  const configPath = resolveConfigPath(homedir);

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
      return installClaudeMcpEntry({ configPath, opts, hooks });
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
  readonly hooks: InternalInstallHooks;
}

async function installClaudeMcpEntry(ctx: InstallContext): Promise<InstallResult> {
  const { configPath, opts, hooks } = ctx;

  let source: string;
  try {
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
  const initialHash = sha256(source);

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

  // Reject (rather than silently overwrite) an mcpServers value that exists
  // but is the wrong shape. Silent replacement would clash with the rest of
  // the flow, which goes to lengths to preserve user state and require
  // --force on every other conflict. `mcpServers: null` is treated as
  // malformed (not "absent") because the key was deliberately set to a
  // non-object value — overwriting that without asking would be the same
  // kind of silent stomp the array/string/number rejection guards against.
  const mcpServersRaw = parsed.mcpServers;
  const mcpServersAbsent = mcpServersRaw === undefined;
  if (
    !mcpServersAbsent &&
    (mcpServersRaw === null || typeof mcpServersRaw !== 'object' || Array.isArray(mcpServersRaw))
  ) {
    return {
      ok: false,
      reason: '~/.claude.json mcpServers is not a JSON object',
      hint: 'open ~/.claude.json and replace mcpServers with `{}`, then re-run',
    };
  }
  const existingServers = mcpServersAbsent ? undefined : (mcpServersRaw as Record<string, unknown>);
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
      // Intentional: a conflicting toolbox entry without --force returns an
      // error even in dryRun mode. dryRun is for previewing the actual
      // outcome of the same flags; previewing the force-overwrite shape
      // requires `dryRun: true, force: true`, which keeps the contract
      // consistent (dryRun mirrors the non-dryRun result, just without
      // filesystem writes) rather than implying "no --force needed".
      return {
        ok: false,
        reason: 'mcpServers.toolbox already present with different command/args',
        hint: 're-run with --force to overwrite (use dryRun + force to preview)',
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

  // tmp filename includes randomUUID so two concurrent install() calls in
  // the same Node process (e.g. tlbx setup orchestrating multiple adapters,
  // or the future Electron app running install in parallel) do not collide
  // on the wx-flagged open and accidentally unlink each other's tmp files
  // on the cleanup path.
  const tmpPath = `${configPath}.tmp.${process.pid}.${randomUUID()}`;
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

  if (hooks.afterTmpWrite) {
    try {
      await hooks.afterTmpWrite();
    } catch (error) {
      await unlinkIfExists(tmpPath);
      throw error;
    }
  }

  // Pre-compute the backup path before the verification so the only thing
  // between "verify unchanged" and "atomically move the original" is the
  // rename syscall itself.
  const backupPath = `${configPath}.bak.${timestampForBackup()}.${process.pid}.${randomUUID()}`;

  // Verify the live file still matches what we read, using a content hash
  // (not mtime+size) so that a same-length rewrite within the filesystem's
  // timestamp granularity cannot silently slip past the check.
  let currentSource: string;
  try {
    currentSource = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    await unlinkIfExists(tmpPath);
    throw error;
  }
  if (sha256(currentSource) !== initialHash) {
    await unlinkIfExists(tmpPath);
    return {
      ok: false,
      reason: '~/.claude.json was modified by another process while we were merging',
      hint: 're-run `tlbx client install claude`',
    };
  }

  // Atomic file replacement, two-step:
  //
  //   1. rename(orig → backup) — atomically moves the verified original
  //      inode to the backup path. After this, the live path is empty and
  //      the backup is decoupled from any subsequent in-place mutation of
  //      the live path (which is why fs.link would have been wrong — a
  //      shared inode lets an O_TRUNC writer leak into the backup).
  //   2. link(tmp → orig) + unlink(tmp) — atomically creates the live
  //      file from our tmp inode, but *fails with EEXIST* if a concurrent
  //      writer (Claude Code, an editor, etc.) recreated the live file
  //      during the gap between the renames. That makes the second step
  //      a true compare-and-swap: it cannot silently clobber a newer
  //      file the way an unconditional rename(tmp, orig) would. On EEXIST
  //      we leave the concurrent writer's update at the live path and
  //      preserve the original at the .bak path for recovery.
  try {
    await fs.rename(configPath, backupPath);
  } catch (error) {
    await unlinkIfExists(tmpPath);
    throw error;
  }

  if (hooks.afterMoveOriginalToBackup) {
    try {
      await hooks.afterMoveOriginalToBackup();
    } catch (error) {
      try {
        await fs.rename(backupPath, configPath);
      } catch {
        // backup remains at backupPath; surface the original error below.
      }
      await unlinkIfExists(tmpPath);
      throw error;
    }
  }

  try {
    await fs.link(tmpPath, configPath);
  } catch (linkError) {
    const code = (linkError as NodeJS.ErrnoException | null)?.code;
    if (code === 'EEXIST') {
      // Concurrent writer beat us to it after we moved the original out.
      // Do not clobber their write. Leave their content at the live path
      // and keep the .bak so the user can reconcile.
      await unlinkIfExists(tmpPath);
      return {
        ok: false,
        reason:
          'another process wrote to ~/.claude.json after we moved the original aside; refusing to overwrite',
        hint: `inspect ${backupPath} for the pre-install content and re-run if you still want to install`,
      };
    }
    // Other link failure: rollback by moving the backup back into place.
    try {
      await fs.rename(backupPath, configPath);
    } catch {
      // backup remains at backupPath; surface the original error below.
    }
    await unlinkIfExists(tmpPath);
    throw linkError;
  }

  // The live path now has the tmp inode (via the hard link). Remove the
  // tmp path so we leave a single name for the new inode.
  await unlinkIfExists(tmpPath);

  return {
    ok: true,
    status: 'installed',
    configPath,
    backupPath,
    diff,
  };
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

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // best-effort cleanup
  }
}
