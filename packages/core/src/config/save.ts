import * as path from 'node:path';

import { atomicWriteFile } from './atomic-write.js';
import { withConfigLock } from './lock.js';
import { resolveConfigPath } from './paths.js';
import type { ToolBoxConfig } from './schema.js';

function serialize(config: ToolBoxConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

export async function saveConfig(config: ToolBoxConfig, filePath?: string): Promise<void> {
  const target = filePath ?? resolveConfigPath();
  // Serialize the write through the shared config-dir lock so no caller is an
  // unlocked escape hatch (e.g. `tlbx init --force`, `tlbx doctor --fix`). For a
  // caller already holding the lock — every read-modify-write command path — the
  // re-entrant bypass makes this a no-op acquire, so it stays one atomic section.
  await withConfigLock(path.dirname(target), () => atomicWriteFile(target, serialize(config)));
}
