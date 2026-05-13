import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ServeDaemonStateSchema, type ServeDaemonState } from './schema.js';

/**
 * Reads the daemon state file at `filePath`. Returns `null` when the file is
 * missing (ENOENT), is not valid JSON, or fails schema validation — those are
 * all "no live daemon" from the caller's perspective. Other I/O errors
 * (e.g. EACCES) propagate so the caller can decide how to surface them.
 */
export async function readServeState(filePath: string): Promise<ServeDaemonState | null> {
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }

  const parsed = ServeDaemonStateSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

/**
 * Atomically writes the daemon state file: serialize → write to a sibling
 * temp file → fsync → rename over the target. A crash or write error before
 * the rename leaves the target untouched, so `readServeState` can never
 * observe a torn / partially-written control file. Uses POSIX rename
 * semantics, which atomically replace the target on Linux / macOS; on
 * Windows, rename will fail if the target already exists and the caller
 * must remove the prior state file first (`clearServeState`).
 */
export async function writeServeState(filePath: string, state: ServeDaemonState): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const serialized = JSON.stringify(state, null, 2) + '\n';

  const tmp = path.join(dir, `${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, filePath);
  } catch (error) {
    await unlinkIfExists(tmp);
    throw error;
  }
}

/**
 * Deletes the state file if it exists. Missing files are a no-op; any other
 * I/O error propagates so the caller can warn the user instead of silently
 * leaking state.
 */
export async function clearServeState(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // best-effort cleanup; if the file does not exist or cannot be removed,
    // the caller is already on an error path and has nothing else to do.
  }
}
