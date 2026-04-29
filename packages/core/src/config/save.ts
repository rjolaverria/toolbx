import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveConfigPath } from './paths.js';
import type { ToolboxConfig } from './schema.js';

function serialize(config: ToolboxConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

export async function saveConfig(config: ToolboxConfig, filePath?: string): Promise<void> {
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
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}
