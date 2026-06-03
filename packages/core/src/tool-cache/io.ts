import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveToolCachePath } from './paths.js';
import { ToolCacheFileSchema, type CachedToolInput, type ToolCacheFile } from './schema.js';

export class ToolCacheError extends Error {
  override readonly name: string = 'ToolCacheError';
  readonly source: string;

  constructor(message: string, source: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.source = source;
  }
}

/**
 * Returned when the cache file does not exist. The CLI maps this to a help
 * message ("run `tlbx serve` first or use `--from-config`").
 */
export class ToolCacheMissingError extends ToolCacheError {
  override readonly name = 'ToolCacheMissingError';
}

export interface WriteToolCacheInput {
  readonly tools: readonly CachedToolInput[];
  /** Override `Date.now()` for deterministic tests. */
  readonly now?: Date;
}

export async function writeToolCache(input: WriteToolCacheInput, filePath?: string): Promise<void> {
  const target = filePath ?? resolveToolCachePath();
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });

  // Not annotated as `ToolCacheFile`: that is the parsed (read) shape where
  // `source` is required, while writers may omit it (defaulted on read). The
  // object is only serialized here, never validated, so the write-side shape is
  // sufficient and honest about the optional field.
  const payload = {
    version: 1 as const,
    updatedAt: (input.now ?? new Date()).toISOString(),
    tools: [...input.tools],
  };
  const serialized = JSON.stringify(payload, null, 2) + '\n';

  const tmp = path.join(dir, `${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
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

export async function readToolCache(filePath?: string): Promise<ToolCacheFile> {
  const target = filePath ?? resolveToolCachePath();
  let source: string;
  try {
    source = await fs.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      throw new ToolCacheMissingError(`No tool cache found at ${target}.`, target, error);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolCacheError(`Failed to read tool cache at ${target}: ${message}`, target, error);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolCacheError(`Failed to parse tool cache at ${target}: ${message}`, target, error);
  }

  const result = ToolCacheFileSchema.safeParse(raw);
  if (!result.success) {
    throw new ToolCacheError(`Invalid tool cache at ${target}: ${result.error.message}`, target);
  }
  return result.data;
}

function isRenameOverwriteFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}
