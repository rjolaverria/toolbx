/**
 * Probe whether a pid corresponds to a live process without sending it a
 * real signal. `process.kill(pid, 0)` performs the permission/existence
 * check the kernel would do for a real signal but does not deliver one.
 *
 * - returns `true` when the process exists and the caller can signal it
 * - returns `true` on `EPERM` — the process exists but we lack permission
 *   (still useful: it means a stale state file is **not** stale)
 * - returns `false` on `ESRCH` — no process with that pid exists
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'EPERM') {
      return true;
    }
    return false;
  }
}
