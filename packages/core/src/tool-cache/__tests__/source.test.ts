import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readToolCache, writeToolCache } from '../io.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
});

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-cache-source-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'tools-cache.json');
}

describe('tool cache — source field', () => {
  it('round-trips a custom tool source', async () => {
    const file = await tempFile();
    await writeToolCache(
      {
        tools: [
          {
            exposedName: 'personal__echo',
            serverName: 'personal',
            upstreamName: 'echo',
            source: 'custom',
            tool: { name: 'personal__echo' },
          },
        ],
      },
      file,
    );
    const cache = await readToolCache(file);
    expect(cache.tools[0]?.source).toBe('custom');
  });

  it('defaults source to upstream for caches written before the field existed', async () => {
    const file = await tempFile();
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        updatedAt: '2026-05-09T12:00:00.000Z',
        tools: [
          {
            exposedName: 'github__create_issue',
            serverName: 'github',
            upstreamName: 'create_issue',
            tool: { name: 'github__create_issue' },
          },
        ],
      }),
      'utf8',
    );
    const cache = await readToolCache(file);
    expect(cache.tools[0]?.source).toBe('upstream');
  });
});
