import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ServeDaemonStateSchema, type ServeDaemonState } from './schema.js';

/**
 * Reads the daemon state file at `filePath`. Returns `null` when the file is
 * missing or unreadable / invalid JSON / fails schema validation — those are
 * all "no live daemon" from the caller's perspective. Other I/O errors
 * propagate so the caller can decide how to surface them.
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

export async function writeServeState(filePath: string, state: ServeDaemonState): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const serialized = JSON.stringify(state, null, 2) + '\n';
  await fs.writeFile(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
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
