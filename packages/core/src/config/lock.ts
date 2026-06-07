import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';

/** Raised when the lock cannot be acquired within the configured timeout. */
export class ConfigLockError extends Error {
  override readonly name = 'ConfigLockError';

  constructor(lockDir: string, timeoutMs: number) {
    super(
      `could not acquire the ToolBox config lock at ${lockDir} within ${timeoutMs}ms; ` +
        `another command may be holding it. If no other command is running, remove ${lockDir} and retry.`,
    );
  }
}

export interface WithConfigLockOptions {
  /** Overall acquire timeout before giving up. Defaults to 10s. */
  readonly timeoutMs?: number;
  /** A lock older than this (by its recorded ts) is stale and stealable. Defaults to 10s. */
  readonly staleMs?: number;
  /** Poll interval between acquire attempts. Defaults to 50ms. */
  readonly pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 10_000;
const DEFAULT_POLL_MS = 50;

interface LockMeta {
  readonly pid: number;
  readonly host: string;
  readonly ts: number;
  /** Random per-acquire token used to verify ownership before release. */
  readonly nonce: string;
}

/** Resolved dirs whose lock is currently held in the active async context. */
const heldDirs = new AsyncLocalStorage<Set<string>>();

/**
 * Runs `fn` while holding an exclusive, config-dir-scoped advisory lock, so the
 * read-modify-write cycle inside `fn` cannot interleave with another holder of
 * the same dir's lock. Both `config.json` and the custom-tool manifest live under
 * one config dir, so routing every mutation through this lock serializes them
 * against each other — closing both the lost-update and cross-store
 * namespace-collision windows.
 *
 * The lock is a `<dir>/.lock` directory published atomically (a staged dir
 * carrying its metadata is `rename`d onto `lockDir`, which only succeeds when the
 * slot is free — cross-platform, no POSIX `flock`). A crashed holder cannot
 * deadlock subsequent commands: a same-host lock is stolen only when its recorded
 * owner pid is no longer alive; a live holder is never stolen on age alone (the
 * meta has no heartbeat, so a long critical section just makes waiters time out
 * rather than steal). Age (`staleMs`) is the staleness signal only for a
 * remote-host lock or one with missing/unreadable metadata, whose liveness cannot
 * be probed locally. Stealing is serialized through a dedicated steal mutex and
 * re-confirms staleness before removing the lock, so it can never delete a live
 * holder's lock (see {@link stealStale}). Release is ownership-checked via a
 * per-acquire nonce.
 *
 * Re-entrant within one async context: a nested call for the same resolved dir
 * runs `fn` directly without re-acquiring, so a command that locks a critical
 * section and then calls a mutator that also locks the same dir does not
 * deadlock. The outermost call owns acquire and release.
 */
export async function withConfigLock<T>(
  dir: string,
  fn: () => Promise<T>,
  options: WithConfigLockOptions = {},
): Promise<T> {
  // Canonicalize so two invocations targeting the same physical directory through
  // different symlink/realpath spellings share one lock (and one re-entrancy key)
  // rather than locking distinct `.lock` dirs and interleaving.
  const resolved = await canonicalizeDir(dir);
  const current = heldDirs.getStore();
  if (current?.has(resolved)) {
    return fn();
  }

  const lockDir = path.join(resolved, '.lock');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const nonce = randomUUID();
  await acquire(lockDir, timeoutMs, staleMs, pollMs, nonce);
  const nextHeld = new Set(current ?? []);
  nextHeld.add(resolved);
  try {
    return await heldDirs.run(nextHeld, fn);
  } finally {
    await releaseLock(lockDir, nonce);
  }
}

/**
 * Resolves `dir` to a canonical absolute path so symlink/realpath spelling
 * differences map to one lock. The directory is created first (the lock lives
 * inside it) so `realpath` can resolve it; if either step fails, fall back to the
 * lexically resolved path rather than blocking the mutation.
 */
async function canonicalizeDir(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  try {
    await fs.mkdir(abs, { recursive: true });
    return await fs.realpath(abs);
  } catch {
    return abs;
  }
}

/** Rename-onto-existing error codes that mean the lock dir is already held. */
function isLockHeldError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  // POSIX rejects a rename onto a non-empty dir with ENOTEMPTY (some kernels
  // EEXIST); Windows reports EEXIST/EPERM/EACCES for the same replace attempt.
  return code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}

async function acquire(
  lockDir: string,
  timeoutMs: number,
  staleMs: number,
  pollMs: number,
  nonce: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(path.dirname(lockDir), { recursive: true });

  // Publish the lock atomically: build a fully-formed dir (with its meta) under a
  // unique name, then `rename` it onto `lockDir`. `rename` succeeds only when
  // `lockDir` is absent, so the lock dir is never present without its metadata —
  // there is no create-then-write window a stealer could exploit. The staging dir
  // is built once and reused across attempts.
  const staging = `${lockDir}.acquiring-${nonce}`;
  const stagingMeta = path.join(staging, 'meta.json');
  await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(staging);

  try {
    for (;;) {
      // Refresh the timestamp on every attempt so a lock published after a long
      // wait carries a current `ts` — otherwise a peer could immediately judge
      // the freshly-acquired lock stale by age and steal it.
      await fs.writeFile(
        stagingMeta,
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          ts: Date.now(),
          nonce,
        } satisfies LockMeta),
        'utf8',
      );
      try {
        await fs.rename(staging, lockDir);
        return;
      } catch (error) {
        if (!isLockHeldError(error)) {
          throw error;
        }
      }

      // Enforce the deadline on every path, including stealing: if a steal cannot
      // make progress (e.g. the steal mutex stays held, or removal keeps
      // failing), the loop must still give up at the deadline rather than spin
      // forever.
      if (Date.now() >= deadline) {
        throw new ConfigLockError(lockDir, timeoutMs);
      }

      if ((await evaluateStale(lockDir, staleMs)).steal) {
        await stealStale(lockDir, staleMs);
        // Retry promptly; the deadline is re-checked at the top of the next
        // iteration after the rename attempt.
        continue;
      }
      await delay(pollMs + Math.floor(Math.random() * pollMs));
    }
  } finally {
    // On a successful rename the staging dir is gone (consumed); on timeout/error
    // it lingers, so clean it up.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Max attempts to grab the brief steal mutex before giving up this round. */
const STEAL_MUTEX_ATTEMPTS = 10;
const STEAL_MUTEX_POLL_MS = 10;

/**
 * Removes a lock judged stale, serialized through a dedicated steal mutex so the
 * removal is provably safe — never deleting a live holder's lock.
 *
 * The safety rests on two invariants. (1) Acquirers publish via `rename` onto
 * `lockDir`, which only succeeds when `lockDir` is absent — so a *present* lock
 * dir can never be silently replaced by a fresh holder; it can only be removed by
 * a stealer. (2) The steal mutex (`<lock>.steal`) serializes stealers, so at most
 * one runs at a time. Holding the mutex, we re-confirm staleness and only then
 * remove the lock: because a present lock can't have become a fresh holder (1)
 * and no other stealer is racing (2), a still-stale lock here is provably the
 * same stale instance, so the removal cannot delete a live holder. After it,
 * normal acquirers race to publish and exactly one wins. The removal goes through
 * {@link discardLockDir} (atomic rename-aside) so it never exposes an empty
 * `lockDir` an acquirer could rename into mid-removal.
 *
 * The re-confirm-before-rm holds even if the steal mutex's own crash-recovery
 * (age-based) momentarily admitted two stealers: a fresh holder published by the
 * first is seen live by the second, which then declines to remove it.
 *
 * Lease bound: like any TTL/lease lock, correctness assumes a stealer does not
 * stall longer than `staleMs` *between* its staleness re-check and the `rm`. With
 * the 10s default and a critical section that only reads metadata and removes a
 * directory, that requires an effectively-frozen (or crashed) process — in which
 * case it will not resume to perform the `rm` anyway.
 */
async function stealStale(lockDir: string, staleMs: number): Promise<void> {
  const stealMutex = `${lockDir}.steal`;
  if (!(await acquireStealMutex(stealMutex, staleMs))) {
    // Another waiter is already stealing; let the main loop retry.
    return;
  }
  try {
    if ((await evaluateStale(lockDir, staleMs)).steal) {
      await discardLockDir(lockDir);
    }
  } finally {
    // The steal mutex is an empty dir, so a plain recursive rm is a single rmdir
    // with no empty-contents window to exploit.
    await fs.rm(stealMutex, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Removes a lock directory without ever exposing it as an empty directory.
 *
 * A recursive `fs.rm(lockDir)` unlinks `meta.json` and *then* `rmdir`s, leaving a
 * brief window where `lockDir` exists but is empty — during which an acquirer's
 * `rename(staging, lockDir)` would succeed (rename replaces an empty dir) and the
 * in-progress `rm` could then delete the new holder's lock, breaking mutual
 * exclusion. Renaming the whole dir aside is a single atomic step: `lockDir`
 * goes straight from present to absent, so an acquirer either fails its rename
 * (still present) or wins cleanly (already gone). The moved copy is then removed
 * off-path, where no acquirer targets it.
 */
async function discardLockDir(lockDir: string): Promise<void> {
  const grave = `${lockDir}.discarding-${randomUUID()}`;
  try {
    await fs.rename(lockDir, grave);
  } catch {
    // Already gone (released/stolen concurrently) — nothing to clean up.
    return;
  }
  await fs.rm(grave, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Grabs the steal mutex (an `mkdir` mutex holding no user code, so normally held
 * only microseconds). Returns false if another stealer holds it. A crashed
 * stealer's mutex is recovered by age — and even a mistaken double-admit is safe,
 * because {@link stealStale} re-confirms staleness before removing the lock.
 */
async function acquireStealMutex(stealMutex: string, staleMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < STEAL_MUTEX_ATTEMPTS; attempt++) {
    try {
      await fs.mkdir(stealMutex);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    try {
      const info = await fs.stat(stealMutex);
      if (Date.now() - info.mtimeMs > staleMs) {
        await fs.rm(stealMutex, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
    } catch {
      // Vanished between mkdir and stat — retry immediately.
      continue;
    }
    await delay(STEAL_MUTEX_POLL_MS);
  }
  return false;
}

/**
 * Removes our lock on release, but only if it is still ours: the nonce check
 * skips removal when the on-disk lock no longer carries our token, and the
 * removal itself is an atomic rename-aside ({@link discardLockDir}).
 *
 * This read-then-rename needs no removal mutex in the supported single-host
 * model. Same-host staleness is decided by pid liveness, not age (see
 * {@link evaluateStale}), and the releasing process is by definition alive, so no
 * stealer ever judges our lock stale and removes it — the lock under our path
 * cannot change between the `readMeta` and the rename. The only ways it could are
 * a cross-host age-based steal (multi-host is an explicit non-goal) or externally
 * corrupted metadata; the nonce check still refuses to remove a lock bearing a
 * different token.
 */
async function releaseLock(lockDir: string, nonce: string): Promise<void> {
  const meta = await readMeta(lockDir);
  if (meta !== undefined && typeof meta.nonce === 'string' && meta.nonce !== nonce) {
    return;
  }
  await discardLockDir(lockDir);
}

type StaleEvaluation = { steal: boolean };

/** Decides whether an existing lock is stale (and therefore stealable). */
async function evaluateStale(lockDir: string, staleMs: number): Promise<StaleEvaluation> {
  const meta = await readMeta(lockDir);

  if (meta && typeof meta.ts === 'number') {
    // Same-host lock: liveness is authoritative. Never steal a live holder on
    // age alone — the meta has no heartbeat, so a long-running critical section
    // legitimately looks "old"; waiters must time out instead. Steal only once
    // the recorded pid is gone.
    if (meta.host === hostname() && typeof meta.pid === 'number') {
      return { steal: !isAlive(meta.pid) };
    }
    // Remote-host lock: its process table cannot be probed locally, so fall back
    // to age as the only available staleness signal.
    return { steal: Date.now() - meta.ts > staleMs };
  }

  // No usable meta: use the lock dir's own age as the staleness signal. A held
  // lock always writes meta (acquire publishes it atomically), so a meta-less dir
  // is a genuinely abandoned/corrupt lock, not a live holder mid-write.
  try {
    const info = await fs.stat(lockDir);
    return { steal: Date.now() - info.mtimeMs > staleMs };
  } catch {
    // The lock dir vanished — treat as stale so the caller retries.
    return { steal: true };
  }
}

async function readMeta(lockDir: string): Promise<LockMeta | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(lockDir, 'meta.json'), 'utf8'),
    ) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      return parsed as LockMeta;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process; EPERM = exists but not ours (treat as alive).
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
