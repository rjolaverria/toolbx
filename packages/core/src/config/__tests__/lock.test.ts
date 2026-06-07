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

/**
 * Fires `count` concurrent acquisitions (optionally over a pre-planted stale
 * lock) and asserts every critical section ran with no overlap.
 */
async function expectExclusive(
  count: number,
  stale: { pid: number; host: string; ts: number } | undefined,
): Promise<void> {
  if (stale !== undefined) {
    await plantLock(stale);
  }
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const run = (): Promise<void> =>
    withConfigLock(
      dir,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 3));
        active -= 1;
        completed += 1;
      },
      // A dead-pid stale lock is stolen via liveness regardless of staleMs; keep
      // staleMs generous so the brief steal mutex is never age-recovered (which
      // would be the lease-bound mis-steal) during the test under load.
      { timeoutMs: 10_000, pollMs: 3, staleMs: 5000 },
    );
  await Promise.all(Array.from({ length: count }, run));
  expect(completed).toBe(count);
  expect(maxActive).toBe(1);
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

  it('does not steal a live same-host holder even when older than the TTL', async () => {
    // A long-running critical section legitimately looks "old" (the meta has no
    // heartbeat). Liveness, not age, is authoritative for same-host locks, so a
    // waiter must time out rather than steal a live holder's lock.
    const dispose = await plantLock({
      pid: process.pid,
      host: hostname(),
      ts: Date.now() - 60_000,
    });
    try {
      await expect(
        withConfigLock(dir, () => Promise.resolve('stolen'), { timeoutMs: 80, staleMs: 1000 }),
      ).rejects.toBeInstanceOf(ConfigLockError);
    } finally {
      await dispose();
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

  it('leaves a lock that was stolen and re-acquired by another owner intact on release', async () => {
    // Simulates the steal race: our critical section runs while a competitor has
    // re-stamped the lock with its own nonce. On release we must not remove the
    // competitor's lock.
    const lockDir = path.join(dir, '.lock');
    await withConfigLock(dir, async () => {
      // Overwrite the meta as if a competitor stole and re-acquired the lock.
      await writeFile(
        path.join(lockDir, 'meta.json'),
        JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), nonce: 'other' }),
      );
    });
    // The competitor's lock dir is still present (we did not delete it).
    expect((await stat(lockDir)).isDirectory()).toBe(true);
    await rm(lockDir, { recursive: true, force: true });
  });

  it('preserves mutual exclusion under high contention', async () => {
    // Many waiters contend for an uncontended-at-start lock. The mutex must let
    // exactly one critical section run at a time — no overlap.
    await expectExclusive(8, undefined);
  });

  it('preserves mutual exclusion while many waiters race to steal one stale lock', async () => {
    // Plant a dead-pid stale lock, then fire many concurrent acquisitions that
    // all see it as stale and race to steal it. The steal-mutex protocol must
    // still admit exactly one critical section at a time.
    await expectExclusive(8, { pid: 2147483646, host: hostname(), ts: Date.now() });
  });

  it('writes a meta record while held', async () => {
    let metaExists = false;
    await withConfigLock(dir, async () => {
      metaExists = (await stat(path.join(dir, '.lock', 'meta.json'))).isFile();
    });
    expect(metaExists).toBe(true);
  });
});
