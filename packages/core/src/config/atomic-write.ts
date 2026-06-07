import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Writes a file atomically: write to a unique temp file in the same directory,
 * fsync it, then `rename` over the target. `rename` replaces an existing file
 * atomically on POSIX and on modern Windows (libuv passes
 * `MOVEFILE_REPLACE_EXISTING`), so a reader always sees either the old file or
 * the fully written new one — never a torn write and never a missing target. If
 * the rename fails the original target is left untouched and the error
 * propagates, after the temp file is cleaned up.
 *
 * This guarantees write atomicity only; it does NOT serialize a read-modify-write
 * cycle, so two processes that read the same file and both write can still lose
 * an update. Cross-process serialization of the read-modify-write cycle is
 * provided separately by {@link withConfigLock}.
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
    // Leave the existing target in place; only the temp file is discarded.
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}
