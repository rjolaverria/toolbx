import { atomicWriteFile } from './atomic-write.js';
import { resolveConfigPath } from './paths.js';
import type { ToolBoxConfig } from './schema.js';

function serialize(config: ToolBoxConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

export async function saveConfig(config: ToolBoxConfig, filePath?: string): Promise<void> {
  const target = filePath ?? resolveConfigPath();
  await atomicWriteFile(target, serialize(config));
}
