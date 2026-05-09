import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readToolCache, ToolCacheError, ToolCacheMissingError, writeToolCache } from '../io.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-tool-cache-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('writeToolCache / readToolCache', () => {
  it('round-trips a snapshot and stamps `updatedAt`', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'tools-cache.json');

    const now = new Date('2026-05-09T12:00:00Z');
    await writeToolCache(
      {
        tools: [
          {
            exposedName: 'github__create_issue',
            serverName: 'github',
            upstreamName: 'create_issue',
            tool: { name: 'github__create_issue', description: 'create' },
          },
        ],
        now,
      },
      file,
    );

    const cache = await readToolCache(file);
    expect(cache.version).toBe(1);
    expect(cache.updatedAt).toBe('2026-05-09T12:00:00.000Z');
    expect(cache.tools).toHaveLength(1);
    expect(cache.tools[0]?.exposedName).toBe('github__create_issue');
  });

  it('overwrites an existing cache file atomically', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'tools-cache.json');

    await writeToolCache({ tools: [], now: new Date('2026-01-01T00:00:00Z') }, file);
    await writeToolCache(
      {
        tools: [
          {
            exposedName: 'jira__search_issues',
            serverName: 'jira',
            upstreamName: 'search_issues',
            tool: { name: 'jira__search_issues' },
          },
        ],
        now: new Date('2026-02-01T00:00:00Z'),
      },
      file,
    );

    const cache = await readToolCache(file);
    expect(cache.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(cache.tools.map((t) => t.exposedName)).toEqual(['jira__search_issues']);
  });

  it('throws ToolCacheMissingError when the file does not exist', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'tools-cache.json');

    await expect(readToolCache(file)).rejects.toBeInstanceOf(ToolCacheMissingError);
  });

  it('throws ToolCacheError on a malformed payload', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'tools-cache.json');
    await fs.writeFile(file, '{"version": 1, "tools": []}', 'utf8');

    await expect(readToolCache(file)).rejects.toBeInstanceOf(ToolCacheError);
  });
});
