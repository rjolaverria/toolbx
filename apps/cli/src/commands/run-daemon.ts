import * as path from 'node:path';

import {
  clearServeState,
  defaultProbeDeps,
  isProcessAlive,
  loadConfig,
  readServeState,
  resolveConfigPath,
  serveDaemonPathsForConfig,
  waitForDaemonReady,
  type LogFormat,
  type LogLevel,
  type ServeDaemonPaths,
  type ServeDaemonState,
  type ToolBoxConfig,
  type WaitForDaemonReadyDeps,
} from '@toolbox/core';

import {
  buildEndpointUrl,
  defaultServeDetachDeps,
  runServeDetached,
  type ServeDetachDeps,
  type ServeDetachOptions,
} from './serve-detach.js';

export interface EnsureDaemonOptions {
  /** Override the resolved config path for this run. */
  config?: string;
  logLevel?: LogLevel;
  logFormat?: LogFormat;
}

/** A ready, reusable ToolBox daemon for a resolved config. */
export interface DaemonHandle {
  readonly url: string;
  readonly pid: number;
  /** `true` when an already-running daemon was reused, `false` when freshly started. */
  readonly reused: boolean;
  readonly configPath: string;
  readonly statePath: string;
  readonly logPath: string;
  /**
   * The config that was loaded to resolve this daemon. Carried out so callers
   * can produce config-aware remediation (bearer vs OAuth auth, disabled vs
   * unknown tools) without re-reading and re-parsing the file (P2-05 §5.5).
   */
  readonly config: ToolBoxConfig;
}

export type EnsureDaemonResult =
  | { readonly ok: true; readonly daemon: DaemonHandle }
  | { readonly ok: false; readonly code: number; readonly message: string };

export interface ColdStartResult {
  readonly code: number;
  /** Anything `serve-detach` wrote to stderr, so the helper can surface it. */
  readonly diagnostic: string;
}

export interface EnsureDaemonDeps {
  resolvePath: () => string;
  loadConfig: (configPath: string) => Promise<ToolBoxConfig>;
  resolveDaemonPaths: (configPath: string) => ServeDaemonPaths;
  readState: (statePath: string) => Promise<ServeDaemonState | null>;
  clearState: (statePath: string) => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  /** Polls the endpoint until it answers or the budget is spent. */
  waitForReady: (url: string) => Promise<boolean>;
  /** Cold-starts a detached, HTTP-forced daemon for the resolved config. */
  coldStart: (options: ServeDetachOptions) => Promise<ColdStartResult>;
}

export function defaultEnsureDaemonDeps(): EnsureDaemonDeps {
  const probeDeps = defaultProbeDeps();
  const readyTimeoutMs = 15_000;
  const waitDeps: WaitForDaemonReadyDeps = {
    ...probeDeps,
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
  return {
    resolvePath: () => resolveConfigPath(),
    loadConfig: (configPath) => loadConfig(configPath),
    resolveDaemonPaths: (configPath) => serveDaemonPathsForConfig(configPath),
    readState: (statePath) => readServeState(statePath),
    clearState: (statePath) => clearServeState(statePath),
    isProcessAlive: (pid) => isProcessAlive(pid),
    waitForReady: (url) =>
      waitForDaemonReady(
        url,
        { timeoutMs: readyTimeoutMs, intervalMs: 150, attemptTimeoutMs: 1_000 },
        waitDeps,
      ),
    coldStart: async (options) => {
      // Capture both of serve-detach's streams. `tlbx run` reserves real stdout
      // for the tool result (§5.4), so the daemon's startup/reuse chatter must
      // never reach it — it is buffered here and only surfaced (on stderr, by
      // the caller) when the cold-start fails.
      let diagnostic = '';
      const append = (msg: string): void => {
        diagnostic += msg;
      };
      const detachDeps: ServeDetachDeps = {
        ...defaultServeDetachDeps(),
        stdout: append,
        stderr: append,
      };
      const code = await runServeDetached(options, detachDeps);
      return { code, diagnostic };
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveConfig(options: EnsureDaemonOptions, deps: EnsureDaemonDeps): string {
  return options.config !== undefined && options.config.length > 0
    ? path.resolve(options.config)
    : deps.resolvePath();
}

/**
 * Ensures a ToolBox daemon is running and ready for the resolved config, then
 * returns a handle to its local HTTP endpoint. Reuses a healthy daemon for the
 * same config, clears stale state, and otherwise cold-starts a detached daemon
 * with HTTP forced on. Never starts a daemon for a different config on a port
 * already held by another process — that surfaces as a collision error from
 * the cold-start path.
 */
export async function ensureDaemon(
  options: EnsureDaemonOptions,
  deps: EnsureDaemonDeps,
): Promise<EnsureDaemonResult> {
  const configPath = resolveConfig(options, deps);

  let config: ToolBoxConfig;
  try {
    config = await deps.loadConfig(configPath);
  } catch (error) {
    return {
      ok: false,
      code: 1,
      message: `tlbx run: failed to load config from ${configPath}: ${errorMessage(error)}`,
    };
  }

  const { statePath, logPath } = deps.resolveDaemonPaths(configPath);
  const endpoint = buildEndpointUrl(config.server.http);

  const existing = await deps.readState(statePath);
  if (existing !== null) {
    if (deps.isProcessAlive(existing.pid)) {
      const url = existing.url ?? endpoint;
      if (await deps.waitForReady(url)) {
        return {
          ok: true,
          daemon: { url, pid: existing.pid, reused: true, configPath, statePath, logPath, config },
        };
      }
      return {
        ok: false,
        code: 1,
        message: `tlbx run: a daemon is recorded (pid ${String(existing.pid)}) but is not responding at ${url}; check ${logPath} or run \`tlbx stop\` and retry`,
      };
    }
    // Stale record — the recorded process is gone. Clear it before cold-start.
    try {
      await deps.clearState(statePath);
    } catch (error) {
      return {
        ok: false,
        code: 1,
        message: `tlbx run: failed to clear stale daemon state at ${statePath}: ${errorMessage(error)}`,
      };
    }
  }

  const { code, diagnostic } = await deps.coldStart({ ...options, forceHttp: true });
  if (code !== 0) {
    const detail = diagnostic.trim();
    return {
      ok: false,
      code,
      message:
        detail.length > 0
          ? detail
          : `tlbx run: failed to start the ToolBox daemon for ${configPath}; see ${logPath} and run \`tlbx doctor\``,
    };
  }

  // serve-detach succeeded: a daemon for this config bound the port and
  // published its state (either our child or a converged concurrent winner).
  const state = await deps.readState(statePath);
  if (state === null || !deps.isProcessAlive(state.pid)) {
    return {
      ok: false,
      code: 1,
      message: `tlbx run: the daemon reported started but no live state is recorded at ${statePath}; see ${logPath}`,
    };
  }

  const url = state.url ?? endpoint;
  if (!(await deps.waitForReady(url))) {
    return {
      ok: false,
      code: 1,
      message: `tlbx run: the daemon did not become ready at ${url}; see ${logPath} and run \`tlbx doctor\``,
    };
  }

  return {
    ok: true,
    daemon: { url, pid: state.pid, reused: false, configPath, statePath, logPath, config },
  };
}
