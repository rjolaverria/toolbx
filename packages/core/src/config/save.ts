import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveConfigPath } from './paths.js';
import type { ToolBoxConfig } from './schema.js';

function serialize(config: ToolBoxConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

export async function saveConfig(config: ToolBoxConfig, filePath?: string): Promise<void> {
  const target = filePath ?? resolveConfigPath();
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const payload = serialize(config);

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
