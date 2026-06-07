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
 * The lock is a `<dir>/.lock` directory (atomic `mkdir` mutex, cross-platform —
 * no POSIX `flock`). A crashed holder cannot deadlock subsequent commands: a
 * same-host lock is stolen only when its recorded owner pid is no longer alive;
 * a live holder is never stolen on age alone (the meta has no heartbeat, so a
 * long critical section just makes waiters time out rather than steal). Age
 * (`staleMs`) is the staleness signal only for a remote-host lock or one with
 * missing/unreadable metadata, whose liveness cannot be probed locally. A steal
 * is an atomic claim-by-rename verified against the observed owner's nonce — not
 * an in-place delete — so two racing waiters cannot each remove the other's
 * freshly acquired lock. Release is likewise ownership-checked via the
 * per-acquire nonce, so a holder whose lock was stolen never removes the new
 * owner's lock.
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
  const resolved = path.resolve(dir);
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
  // there is no create-then-write window a stealer could exploit. A failed
  // rename leaves the prepared dir in place to retry, so it is built once.
  const staging = `${lockDir}.acquiring-${nonce}`;
  await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(staging);
  await fs.writeFile(
    path.join(staging, 'meta.json'),
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      ts: Date.now(),
      nonce,
    } satisfies LockMeta),
    'utf8',
  );

  try {
    for (;;) {
      try {
        await fs.rename(staging, lockDir);
        return;
      } catch (error) {
        if (!isLockHeldError(error)) {
          throw error;
        }
      }

      const evaluation = await evaluateStale(lockDir, staleMs);
      if (evaluation.steal) {
        await stealStale(lockDir, evaluation.nonce);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ConfigLockError(lockDir, timeoutMs);
      }
      await delay(pollMs + Math.floor(Math.random() * pollMs));
    }
  } finally {
    // On a successful rename the staging dir is gone (consumed); on timeout/error
    // it lingers, so clean it up.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Atomically claims a lock judged stale, instead of deleting it in place. A bare
 * `rm` is a TOCTOU: two waiters can both observe the same stale lock and the
 * second can delete a fresh lock the first just acquired. Renaming to a unique
 * name is atomic — only one waiter can move a given directory; the loser sees
 * `ENOENT` and simply retries `mkdir`. After claiming, the moved dir's nonce is
 * verified against the one observed when the staleness decision was made: if a
 * fresh holder re-created the lock between the evaluation and the rename, the
 * claimed dir carries a different nonce, so it is renamed back rather than
 * deleted — never destroying a live holder's lock.
 */
async function stealStale(lockDir: string, expectedNonce: string | undefined): Promise<void> {
  const claimed = `${lockDir}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockDir, claimed);
  } catch {
    // Already stolen by another waiter, or the holder released — retry mkdir.
    return;
  }

  // If the claimed dir now carries a nonce that differs from the one we judged
  // stale (including the case where we judged a meta-less dir but claimed one a
  // fresh holder has since stamped), we moved a fresh holder's lock — put it
  // back rather than delete it.
  const claimedMeta = await readMeta(claimed);
  if (claimedMeta?.nonce !== undefined && claimedMeta.nonce !== expectedNonce) {
    try {
      await fs.rename(claimed, lockDir);
      return;
    } catch {
      // A third party took the slot during the restore (a vanishingly narrow
      // window). Drop our claimed copy and let normal contention resolve.
      await fs.rm(claimed, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
  }

  await fs.rm(claimed, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Removes the lock directory only if we still own it (the on-disk nonce matches
 * the one written at acquire), so a holder whose lock was stolen as stale does
 * not delete the new owner's lock. A missing/unreadable meta is treated as ours
 * to remove — best-effort cleanup of a lock nobody else has re-stamped.
 */
async function releaseLock(lockDir: string, nonce: string): Promise<void> {
  const meta = await readMeta(lockDir);
  if (meta !== undefined && typeof meta.nonce === 'string' && meta.nonce !== nonce) {
    return;
  }
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
}

type StaleEvaluation = { steal: false } | { steal: true; nonce?: string };

/**
 * Decides whether an existing lock is stale and, if so, the nonce of the owner
 * we judged stale (so the steal can verify it claimed that same instance).
 */
async function evaluateStale(lockDir: string, staleMs: number): Promise<StaleEvaluation> {
  const meta = await readMeta(lockDir);

  if (meta && typeof meta.ts === 'number') {
    // Same-host lock: liveness is authoritative. Never steal a live holder on
    // age alone — the meta has no heartbeat, so a long-running critical section
    // legitimately looks "old"; waiters must time out instead. Steal only once
    // the recorded pid is gone.
    if (meta.host === hostname() && typeof meta.pid === 'number') {
      return isAlive(meta.pid) ? { steal: false } : { steal: true, nonce: meta.nonce };
    }
    // Remote-host lock: its process table cannot be probed locally, so fall back
    // to age as the only available staleness signal.
    return Date.now() - meta.ts > staleMs ? { steal: true, nonce: meta.nonce } : { steal: false };
  }

  // No usable meta: use the lock dir's own age as the staleness signal. A held
  // lock always writes meta (acquire aborts otherwise), so a meta-less dir is a
  // genuinely abandoned/corrupt lock, not a live holder mid-write.
  try {
    const info = await fs.stat(lockDir);
    return Date.now() - info.mtimeMs > staleMs ? { steal: true } : { steal: false };
  } catch {
    // The lock dir vanished — treat as stale so the caller retries the mkdir.
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
