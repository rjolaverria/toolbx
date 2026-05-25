import { request as nodeHttpRequest } from 'node:http';

/**
 * Outcome of a single HTTP probe against a daemon's MCP endpoint.
 *
 * `reachable: true` means the endpoint produced an HTTP response — the daemon
 * is bound and serving on that host/port, regardless of the status code (a
 * ToolBox daemon answers a bare GET with `400 mcp-session-id header required`,
 * which still proves it is up). `reachable: false` distinguishes a closed port
 * (`refused`) from a probe that ran out of time (`timeout`) or hit another
 * transport-level error (`error`).
 */
export type DaemonProbeOutcome =
  | { readonly reachable: true; readonly status: number }
  | {
      readonly reachable: false;
      readonly reason: 'refused' | 'timeout' | 'error';
      readonly message?: string;
    };

export interface ProbeDeps {
  /**
   * Performs one HTTP GET against `url`, resolving with the response status
   * code as soon as headers arrive, or rejecting on a transport error. The
   * request must abort after `timeoutMs` and reject with an error whose
   * `code === 'ETIMEDOUT'` so the caller can classify it.
   */
  httpGet: (url: string, timeoutMs: number) => Promise<number>;
}

export function defaultProbeDeps(): ProbeDeps {
  return {
    httpGet: (url, timeoutMs) =>
      new Promise<number>((resolve, reject) => {
        const req = nodeHttpRequest(url, { method: 'GET' }, (res) => {
          const status = res.statusCode ?? 0;
          // Drain and discard the body so the socket can be freed/reused.
          res.resume();
          resolve(status);
        });
        req.setTimeout(timeoutMs, () => {
          const error = new Error(
            `probe timed out after ${String(timeoutMs)}ms`,
          ) as NodeJS.ErrnoException;
          error.code = 'ETIMEDOUT';
          req.destroy(error);
        });
        req.on('error', (error) => {
          reject(error);
        });
        req.end();
      }),
  };
}

/**
 * Performs a single readiness probe against `url`. Never throws — transport
 * errors are mapped onto the `DaemonProbeOutcome` union so callers can branch
 * on whether the port is closed vs. answering.
 */
export async function probeDaemonEndpoint(
  url: string,
  timeoutMs: number,
  deps: ProbeDeps,
): Promise<DaemonProbeOutcome> {
  try {
    const status = await deps.httpGet(url, timeoutMs);
    return { reachable: true, status };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      return { reachable: false, reason: 'refused' };
    }
    if (code === 'ETIMEDOUT') {
      return { reachable: false, reason: 'timeout' };
    }
    return {
      reachable: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface WaitForDaemonReadyOptions {
  /** Overall budget across all attempts before giving up. */
  readonly timeoutMs: number;
  /** Delay between attempts when the endpoint is not yet reachable. */
  readonly intervalMs: number;
  /** Per-attempt HTTP timeout. */
  readonly attemptTimeoutMs: number;
}

export interface WaitForDaemonReadyDeps extends ProbeDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Polls `url` until it answers an HTTP request or the overall `timeoutMs`
 * budget is exhausted. Returns `true` as soon as the endpoint is reachable,
 * `false` on timeout. At least one probe always runs even when `timeoutMs` is
 * `0`, so a daemon that is already up is detected without waiting.
 */
export async function waitForDaemonReady(
  url: string,
  options: WaitForDaemonReadyOptions,
  deps: WaitForDaemonReadyDeps,
): Promise<boolean> {
  const deadline = deps.now() + options.timeoutMs;
  for (;;) {
    const outcome = await probeDaemonEndpoint(url, options.attemptTimeoutMs, deps);
    if (outcome.reachable) {
      return true;
    }
    if (deps.now() + options.intervalMs >= deadline) {
      return false;
    }
    await deps.sleep(options.intervalMs);
  }
}
