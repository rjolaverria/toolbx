import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigLockError, withConfigLock } from '../lock.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tlbx-lock-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Plants a held lock with an explicit meta record, so tests can simulate a
 * live, dead-pid, or stale (old-ts) holder. Returns a disposer that removes it.
 */
async function plantLock(meta: {
  pid: number;
  host: string;
  ts: number;
}): Promise<() => Promise<void>> {
  const lockDir = path.join(dir, '.lock');
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, 'meta.json'), JSON.stringify(meta), 'utf8');
  return async () => {
    await rm(lockDir, { recursive: true, force: true });
  };
}

describe('withConfigLock', () => {
  it('serializes two overlapping critical sections', async () => {
    const order: string[] = [];
    const slow = withConfigLock(dir, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('a-end');
    });
    // Give A time to take the lock first.
    await new Promise((r) => setTimeout(r, 5));
    const fast = withConfigLock(dir, () => {
      order.push('b');
      return Promise.resolve();
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('releases the lock when fn throws', async () => {
    await expect(withConfigLock(dir, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    const got = await withConfigLock(dir, () => Promise.resolve('ok'));
    expect(got).toBe('ok');
  });

  it('is re-entrant for the same dir within one async context', async () => {
    const result = await withConfigLock(dir, () =>
      withConfigLock(dir, () => Promise.resolve('inner')),
    );
    expect(result).toBe('inner');
  });

  it('steals a lock whose owner pid is dead (same host)', async () => {
    // 2147483646 is well above any real pid on the test host, so kill(pid, 0)
    // reports ESRCH (no such process).
    const dispose = await plantLock({ pid: 2147483646, host: hostname(), ts: Date.now() });
    try {
      const got = await withConfigLock(dir, () => Promise.resolve('stolen'));
      expect(got).toBe('stolen');
    } finally {
      await dispose().catch(() => undefined);
    }
  });

  it('steals a lock older than the TTL even with a live pid on another host', async () => {
    const dispose = await plantLock({
      pid: process.pid,
      host: 'someotherhost',
      ts: Date.now() - 60_000,
    });
    try {
      const got = await withConfigLock(dir, () => Promise.resolve('stolen'), { staleMs: 1000 });
      expect(got).toBe('stolen');
    } finally {
      await dispose().catch(() => undefined);
    }
  });

  it('throws ConfigLockError when a live, non-stale lock never frees in time', async () => {
    const dispose = await plantLock({ pid: process.pid, host: hostname(), ts: Date.now() });
    try {
      await expect(
        withConfigLock(dir, () => Promise.resolve('never'), { timeoutMs: 80, staleMs: 60_000 }),
      ).rejects.toBeInstanceOf(ConfigLockError);
    } finally {
      await dispose();
    }
  });

  it('writes a meta record while held', async () => {
    let metaExists = false;
    await withConfigLock(dir, async () => {
      metaExists = (await stat(path.join(dir, '.lock', 'meta.json'))).isFile();
    });
    expect(metaExists).toBe(true);
  });
});
