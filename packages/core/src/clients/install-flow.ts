import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';

import type { InstallOpts, InstallResult } from './types.js';

/**
 * Test-only hooks reachable from `__tests__/install-flow.test.ts`. Not part of
 * the public API surface — adapters never construct these in production paths.
 */
export interface InternalInstallFlowHooks {
  readonly afterTmpWrite?: () => Promise<void>;
  readonly afterMoveOriginalToBackup?: () => Promise<void>;
}

export interface InstallFlowMergeInput {
  /** Current file contents, or '' if `exists` is false. */
  readonly currentText: string;
  /** Whether the configPath existed when we read it. */
  readonly exists: boolean;
  readonly opts: InstallOpts;
}

export type InstallFlowMergeResult =
  | {
      ok: true;
      status: 'installed';
      nextContent: string;
      diff: string;
    }
  | {
      ok: true;
      status: 'already-installed';
      diff: '';
    }
  | {
      ok: false;
      reason: string;
      hint?: string;
    };

export interface InstallFlowContext {
  readonly configPath: string;
  readonly opts: InstallOpts;
  readonly hooks: InternalInstallFlowHooks;
  readonly merge: (input: InstallFlowMergeInput) => InstallFlowMergeResult;
}

/**
 * Runs the shared atomic-install protocol. Read the live file, hand its
 * contents to `merge`, and — if the merge wants to write — perform the
 * race-safe rename/link/backup dance.
 */
export async function runInstallFlow(ctx: InstallFlowContext): Promise<InstallResult> {
  const { configPath, opts, hooks, merge } = ctx;

  let currentText = '';
  let exists = true;
  try {
    currentText = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      throw error;
    }
    exists = false;
  }
  const initialHash = sha256(currentText);

  const merged = merge({ currentText, exists, opts });
  if (!merged.ok) {
    return merged;
  }
  if (merged.status === 'already-installed') {
    return { ok: true, status: 'already-installed', configPath, diff: '' };
  }

  if (opts.dryRun) {
    return { ok: true, status: 'installed', configPath, diff: merged.diff };
  }

  // tmp filename includes randomUUID so two concurrent install() calls in the
  // same Node process (e.g. tlbx setup orchestrating multiple adapters) do not
  // collide on the wx-flagged open and accidentally unlink each other's tmp
  // files on the cleanup path.
  const tmpPath = `${configPath}.tmp.${String(process.pid)}.${randomUUID()}`;
  try {
    const handle = await fs.open(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(merged.nextContent, 'utf8');
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
  const backupPath = `${configPath}.bak.${timestampForBackup()}.${String(process.pid)}.${randomUUID()}`;

  // Verify the live file is unchanged via content hash (not mtime+size) so a
  // same-length rewrite within the filesystem's timestamp granularity cannot
  // silently slip past the check. When the file did not exist at read time,
  // "unchanged" means "still does not exist".
  let liveText: string;
  let liveExists = true;
  try {
    liveText = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      await unlinkIfExists(tmpPath);
      throw error;
    }
    liveText = '';
    liveExists = false;
  }
  if (liveExists !== exists || sha256(liveText) !== initialHash) {
    await unlinkIfExists(tmpPath);
    return {
      ok: false,
      reason: `${configPath} was modified by another process while we were merging`,
      hint: 're-run the install',
    };
  }

  // Atomic file replacement, two-step:
  //
  //   1. rename(orig → backup) — moves the verified original inode to the
  //      backup path. After this, the live path is empty and the backup is
  //      decoupled from any subsequent in-place mutation of the live path.
  //   2. link(tmp → orig) + unlink(tmp) — creates the live file from our tmp
  //      inode, but *fails with EEXIST* if a concurrent writer recreated the
  //      live file during the gap between the renames. On EEXIST we leave
  //      the concurrent writer's update at the live path and preserve the
  //      original at the .bak path for recovery.
  if (exists) {
    try {
      await fs.rename(configPath, backupPath);
    } catch (error) {
      await unlinkIfExists(tmpPath);
      throw error;
    }
  }

  if (hooks.afterMoveOriginalToBackup) {
    try {
      await hooks.afterMoveOriginalToBackup();
    } catch (error) {
      if (exists) {
        try {
          await fs.rename(backupPath, configPath);
        } catch {
          // backup remains at backupPath; surface the original error below.
        }
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
      await unlinkIfExists(tmpPath);
      return {
        ok: false,
        reason: `another process wrote to ${configPath} after we moved the original aside; refusing to overwrite`,
        hint: exists
          ? `inspect ${backupPath} for the pre-install content and re-run if you still want to install`
          : 're-run the install',
      };
    }
    if (exists) {
      try {
        await fs.rename(backupPath, configPath);
      } catch {
        // backup remains at backupPath.
      }
    }
    await unlinkIfExists(tmpPath);
    throw linkError;
  }

  await unlinkIfExists(tmpPath);

  return {
    ok: true,
    status: 'installed',
    configPath,
    ...(exists ? { backupPath } : {}),
    diff: merged.diff,
  };
}

function timestampForBackup(): string {
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
