import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Writes a file atomically: write to a unique temp file in the same directory,
 * fsync it, then rename over the target. A reader therefore sees either the old
 * file or the fully written new one, never a torn write — so a crash or a
 * concurrent reader cannot observe a half-written (corrupt) manifest.
 *
 * This mirrors how ToolBox persists `config.json` (see `@toolbox/core`'s
 * `saveConfig`). It guarantees write atomicity only; it does NOT serialize a
 * read-modify-write cycle, so two processes that read the same manifest and both
 * write can still lose an update. Cross-process serialization is a config-layer
 * wide concern tracked separately.
 */
export async function atomicWriteFile(target: string, payload: string): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();

  try {
    await fs.rename(tmp, target);
  } catch (error) {
    if (isRenameOverwriteFailure(error)) {
      try {
        await fs.unlink(target);
        await fs.rename(tmp, target);
        return;
      } catch (retryError) {
        await fs.unlink(tmp).catch(() => undefined);
        throw retryError;
      }
    }
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

function isRenameOverwriteFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}
