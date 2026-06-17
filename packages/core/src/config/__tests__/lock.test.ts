import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigLockError, stealStale, withConfigLock } from '../lock.js';

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
    // Wait until A is actually inside its critical section (and thus holds the
    // lock) before starting B — a fixed sleep races A's acquire under load.
    while (!order.includes('a-start')) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const fast = withConfigLock(dir, () => {
      order.push('b');
      return Promise.resolve();
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('serializes two spellings of the same directory via a symlink', async () => {
    // A symlink pointing at `dir`: locking through the link and through the real
    // path must share one lock, not interleave.
    const link = path.join(await mkdtemp(path.join(tmpdir(), 'tlbx-link-')), 'cfg');
    await symlink(dir, link, 'dir');
    try {
      const order: string[] = [];
      const viaReal = withConfigLock(dir, async () => {
        order.push('real-start');
        await new Promise((r) => setTimeout(r, 50));
        order.push('real-end');
      });
      await new Promise((r) => setTimeout(r, 5));
      const viaLink = withConfigLock(link, () => {
        order.push('link');
        return Promise.resolve();
      });
      await Promise.all([viaReal, viaLink]);
      expect(order).toEqual(['real-start', 'real-end', 'link']);
    } finally {
      await rm(path.dirname(link), { recursive: true, force: true });
    }
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

  it('async work that escaped fn re-acquires instead of taking the stale re-entrant bypass', async () => {
    let active = 0;
    let maxActive = 0;
    const body = (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((r) =>
        setTimeout(() => {
          active -= 1;
          r();
        }, 30),
      );
    };

    let leaked!: Promise<void>;
    await withConfigLock(dir, () => {
      // Scheduled inside fn (so it inherits the held-dir async context) but runs
      // after this lock has released. With a live re-entrancy key it must NOT
      // bypass acquisition.
      leaked = (async () => {
        await new Promise((r) => setTimeout(r, 10));
        await withConfigLock(dir, body, { timeoutMs: 5000, pollMs: 3 });
      })();
      return new Promise((r) => setTimeout(r, 1));
    });

    // A real competing holder taken after the outer lock released.
    const competitor = withConfigLock(dir, body, { timeoutMs: 5000, pollMs: 3 });
    await Promise.all([leaked, competitor]);
    expect(maxActive).toBe(1);
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

  it('times out instead of spinning when a stale lock cannot be stolen', async () => {
    // A dead-pid lock is stale, but the steal mutex is held (fresh, not
    // age-recoverable within the test), so stealing never makes progress. The
    // acquire loop must still give up at the deadline rather than spin forever.
    await plantLock({ pid: 2147483646, host: hostname(), ts: Date.now() });
    await mkdir(path.join(dir, '.lock.steal'));
    try {
      await expect(
        withConfigLock(dir, () => Promise.resolve('x'), {
          timeoutMs: 80,
          staleMs: 10_000,
          pollMs: 10,
        }),
      ).rejects.toBeInstanceOf(ConfigLockError);
    } finally {
      await rm(path.join(dir, '.lock.steal'), { recursive: true, force: true });
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

  // Fires `seedSlot` to set up the slot the steal re-confirm will see, then —
  // via the `afterReconfirm` seam, after the re-confirm and before the removal —
  // publishes a racing live lock into the slot, exactly as a fresh acquirer would
  // under parallel threadpool contention. The steal must leave that live lock in
  // place; a readable `meta.json` afterwards proves it was not removed.
  async function expectStealKeepsRacingLiveLock(seedSlot: () => Promise<void>): Promise<void> {
    const lockDir = path.join(dir, '.lock');
    await seedSlot();
    let livePublished = false;
    await stealStale(lockDir, 0, async () => {
      // Replace the slot with a freshly published live lock (a non-empty dir).
      await rm(lockDir, { recursive: true, force: true });
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, 'meta.json'),
        JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), nonce: 'live' }),
        'utf8',
      );
      livePublished = true;
    });
    expect(livePublished).toBe(true);
    const meta = JSON.parse(await readFile(path.join(lockDir, 'meta.json'), 'utf8')) as {
      nonce: string;
    };
    expect(meta.nonce).toBe('live');
  }

  it('does not remove a live lock published into a slot absent at re-confirm', async () => {
    // The re-confirm sees no lock dir ("gone"); a fresh holder then publishes into
    // the empty slot before the removal runs. The steal must not rename it away.
    await expectStealKeepsRacingLiveLock(() => Promise.resolve());
  });

  it('does not remove a live lock published into an empty stale slot at re-confirm', async () => {
    // The re-confirm sees a stale *empty* (meta-less) lock dir. An empty dir is
    // replaceable — `rename(staging, lockDir)` succeeds onto it — so a fresh holder
    // can publish into it before the removal. The empty-only `rmdir` must refuse to
    // remove the now non-empty live lock.
    await expectStealKeepsRacingLiveLock(async () => {
      const lockDir = path.join(dir, '.lock');
      await mkdir(lockDir);
      // Age the empty dir well past the staleMs=0 used by the steal so it reads as
      // stale by directory mtime.
      const past = new Date(Date.now() - 60_000);
      await utimes(lockDir, past, past);
    });
  });

  it('reclaims a stale lock whose meta.json is corrupt', async () => {
    // A present-but-corrupt meta.json is a non-empty dir a fresh acquirer cannot
    // replace, so it is safe — and necessary — to remove it by rename-aside. Left
    // to the empty-only rmdir it would be unstealable until acquire timeout.
    const lockDir = path.join(dir, '.lock');
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, 'meta.json'), 'not json{', 'utf8');
    const past = new Date(Date.now() - 60_000);
    await utimes(lockDir, past, past);

    await stealStale(lockDir, 0);

    await expect(stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims a stale non-empty lock dir that has no meta.json', async () => {
    // A leftover .lock dir holding a non-meta file but no meta.json is non-empty,
    // so a fresh acquirer cannot rename onto it (it is stable, never a live
    // holder). The empty-only rmdir fails ENOTEMPTY, so the steal must fall back
    // to rename-aside and still reclaim it rather than leave it unstealable.
    const lockDir = path.join(dir, '.lock');
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, 'leftover.tmp'), 'stray', 'utf8');
    const past = new Date(Date.now() - 60_000);
    await utimes(lockDir, past, past);

    await stealStale(lockDir, 0);

    await expect(stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a non-empty slot that fills in after an empty re-confirm', async () => {
    // The re-confirm sees an empty slot, so the steal takes the empty-only rmdir
    // path. A non-empty dir is then in place by the time the removal runs (a fresh
    // holder may have published). The rmdir must hit ENOTEMPTY and leave it rather
    // than escalate to a rename-aside that could remove a live lock; a genuinely
    // stale non-empty slot is reclaimed at evaluate time instead.
    const lockDir = path.join(dir, '.lock');
    await mkdir(lockDir);
    const past = new Date(Date.now() - 60_000);
    await utimes(lockDir, past, past);

    await stealStale(lockDir, 0, async () => {
      await writeFile(path.join(lockDir, 'leftover.tmp'), 'x', 'utf8');
    });

    expect((await stat(lockDir)).isDirectory()).toBe(true);
  });

  it('writes a meta record while held', async () => {
    let metaExists = false;
    await withConfigLock(dir, async () => {
      metaExists = (await stat(path.join(dir, '.lock', 'meta.json'))).isFile();
    });
    expect(metaExists).toBe(true);
  });
});
