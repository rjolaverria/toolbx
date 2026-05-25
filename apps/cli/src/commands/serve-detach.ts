import { spawn, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  clearServeState,
  defaultProbeDeps,
  isProcessAlive,
  loadConfig,
  probeDaemonEndpoint,
  readServeState,
  resolveConfigPath,
  serveDaemonPathsForConfig,
  type LogFormat,
  type LogLevel,
  type ServeDaemonPaths,
  type ServeDaemonState,
  type ToolBoxConfig,
} from '@toolbox/core';

import { SERVE_FORCE_HTTP_ENV, SERVE_LOG_PATH_ENV, SERVE_STATE_PATH_ENV } from './serve.js';

export interface ServeDetachOptions {
  stdio?: boolean;
  http?: boolean;
  /**
   * Bind HTTP even when `server.http.enabled` is `false`. Set by the `tlbx
   * run` spawn path; an explicit `tlbx serve --detach` leaves it unset so the
   * `http.enabled` precondition still gates the operator-facing command.
   */
  forceHttp?: boolean;
  config?: string;
  logLevel?: LogLevel;
  logFormat?: LogFormat;
}

export interface SpawnedChildHandle {
  readonly pid: number | undefined;
  unref: () => void;
  on: (
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) => void;
}

export interface ServeDetachDeps {
  resolvePath: () => string;
  loadConfig: (path: string) => Promise<ToolBoxConfig>;
  resolveDaemonPaths: (configPath: string) => ServeDaemonPaths;
  readState: (statePath: string) => Promise<ServeDaemonState | null>;
  clearState: (statePath: string) => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  /** Single HTTP readiness probe; resolves `true` when the endpoint answers. */
  probeReady: (url: string) => Promise<boolean>;
  openLogFd: (logPath: string) => Promise<number>;
  closeFd: (fd: number) => Promise<void>;
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedChildHandle;
  /**
   * Signals an already-spawned child by pid. Used to tear down our child when
   * it loses the port race to a sibling or fails to become ready in time.
   */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Resolves the CLI entry script the child should run (`process.argv[1]`). */
  resolveEntryScript: () => string;
  /** Path to the Node binary the child should run under (`process.execPath`). */
  nodeExecPath: () => string;
  /** Inherited env handed to the child (the managed-daemon markers are merged in). */
  processEnv: NodeJS.ProcessEnv;
  /** Overall budget to wait for the child to publish its state file. */
  readinessTimeoutMs: number;
  /** Poll interval while waiting for the child to publish state. */
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Monotonic clock (ms) used to bound the readiness wait. */
  now: () => number;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

export function defaultServeDetachDeps(): ServeDetachDeps {
  const probeDeps = defaultProbeDeps();
  return {
    resolvePath: () => resolveConfigPath(),
    loadConfig: (p) => loadConfig(p),
    resolveDaemonPaths: (configPath) => serveDaemonPathsForConfig(configPath),
    readState: (p) => readServeState(p),
    clearState: (p) => clearServeState(p),
    isProcessAlive: (pid) => isProcessAlive(pid),
    probeReady: async (url) => {
      const outcome = await probeDaemonEndpoint(url, 1_000, probeDeps);
      return outcome.reachable;
    },
    openLogFd: async (logPath) => {
      await fsp.mkdir(path.dirname(logPath), { recursive: true });
      // Use sync open to get a raw integer fd that Node will not GC out from
      // under us before spawn() dup's it into the child.
      return fs.openSync(logPath, 'a', 0o600);
    },
    closeFd: async (fd) => {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort; if Node already closed it, nothing to do.
      }
      await Promise.resolve();
    },
    spawn: (command, args, options) => {
      const child = spawn(command, [...args], options);
      const handle: SpawnedChildHandle = {
        pid: child.pid,
        unref: () => {
          child.unref();
        },
        on: (event, listener) => {
          child.on(event, listener);
        },
      };
      return handle;
    },
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    resolveEntryScript: () => {
      const argv1 = process.argv[1];
      if (argv1 === undefined || argv1.length === 0) {
        throw new Error(
          'tlbx serve --detach: cannot determine the CLI entry script (process.argv[1] is empty)',
        );
      }
      return argv1;
    },
    nodeExecPath: () => process.execPath,
    processEnv: process.env,
    readinessTimeoutMs: 15_000,
    pollIntervalMs: 100,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    now: () => Date.now(),
    stdout: (msg) => {
      process.stdout.write(msg);
    },
    stderr: (msg) => {
      process.stderr.write(msg);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildChildArgs(options: ServeDetachOptions, configPath: string): string[] {
  const args: string[] = ['serve', '--http', '--config', configPath];
  if (options.logLevel !== undefined) {
    args.push('--log-level', options.logLevel);
  }
  if (options.logFormat !== undefined) {
    args.push('--log-format', options.logFormat);
  }
  return args;
}

export function buildEndpointUrl(http: ToolBoxConfig['server']['http']): string {
  const host = http.host === '::1' ? '[::1]' : http.host;
  return `http://${host}:${String(http.port)}${http.path}`;
}

/**
 * Outcome of waiting for the spawned child to publish its state file.
 *
 * `started` — our child bound the port and published its own record.
 * `reused` — a sibling daemon for the same config won the port race and
 *   published first; our child was torn down and the sibling is reused.
 * `died` — the child exited before binding and nothing is on the port.
 * `collision` — the child could not bind because the port is held by a
 *   foreign process or a ToolBox daemon for a different config.
 * `timeout` — the child neither published nor died within the budget.
 */
type WaitOutcome =
  | { readonly kind: 'started'; readonly state: ServeDaemonState }
  | { readonly kind: 'reused'; readonly state: ServeDaemonState }
  | { readonly kind: 'died' }
  | { readonly kind: 'collision' }
  | { readonly kind: 'timeout' };

interface WaitContext {
  readonly childPid: number;
  readonly statePath: string;
  readonly endpoint: string;
  readonly exitInfo: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}

async function waitForChildState(ctx: WaitContext, deps: ServeDetachDeps): Promise<WaitOutcome> {
  const deadline = deps.now() + deps.readinessTimeoutMs;
  for (;;) {
    const state = await deps.readState(ctx.statePath);
    if (state !== null && deps.isProcessAlive(state.pid)) {
      if (state.pid === ctx.childPid) {
        return { kind: 'started', state };
      }
      // A sibling for the same config bound first. Our child either lost the
      // bind already or is about to — tear it down so we don't orphan it.
      tryKill(ctx.childPid, deps);
      return { kind: 'reused', state };
    }

    if (ctx.exitInfo() !== null || !deps.isProcessAlive(ctx.childPid)) {
      // Our child exited without publishing — it lost the bind or crashed.
      const reachable = await deps.probeReady(ctx.endpoint);
      if (reachable) {
        // Something is on the port. A same-config sibling publishes to the
        // same state path; re-check once before declaring a foreign collision.
        const sibling = await deps.readState(ctx.statePath);
        if (sibling !== null && deps.isProcessAlive(sibling.pid)) {
          return { kind: 'reused', state: sibling };
        }
        return { kind: 'collision' };
      }
      return { kind: 'died' };
    }

    if (deps.now() + deps.pollIntervalMs >= deadline) {
      tryKill(ctx.childPid, deps);
      return { kind: 'timeout' };
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}

function tryKill(pid: number, deps: ServeDetachDeps): void {
  try {
    deps.kill(pid, 'SIGTERM');
  } catch {
    // best-effort: the pid may already be gone (ESRCH) or unreachable.
  }
}

export async function runServeDetached(
  options: ServeDetachOptions,
  deps: ServeDetachDeps,
): Promise<number> {
  if (options.stdio === true) {
    deps.stderr(
      'tlbx serve: --detach and --stdio are mutually exclusive (stdio needs the parent terminal as its transport)\n',
    );
    return 2;
  }

  const configPath =
    options.config !== undefined && options.config.length > 0
      ? path.resolve(options.config)
      : deps.resolvePath();

  let config: ToolBoxConfig;
  try {
    config = await deps.loadConfig(configPath);
  } catch (error) {
    deps.stderr(`tlbx serve: failed to load config from ${configPath}: ${errorMessage(error)}\n`);
    return 1;
  }

  if (!config.server.http.enabled && options.forceHttp !== true) {
    deps.stderr(
      'tlbx serve: --detach requires server.http.enabled in config; enable it first or run in foreground\n',
    );
    return 1;
  }

  const { statePath, logPath } = deps.resolveDaemonPaths(configPath);
  const endpoint = buildEndpointUrl(config.server.http);

  const existing = await deps.readState(statePath);
  if (existing !== null) {
    if (deps.isProcessAlive(existing.pid)) {
      if (options.forceHttp === true) {
        // The `tlbx run` path tolerates an already-running daemon: reuse it.
        deps.stdout(
          `tlbx serve: reusing running daemon (pid ${String(existing.pid)}) on ${existing.url ?? endpoint}\n`,
        );
        return 0;
      }
      deps.stderr(
        `tlbx serve: already running (pid ${String(existing.pid)}); logs at ${existing.logPath}\n`,
      );
      return 1;
    }
    // Stale state — clean it up before spawning a fresh daemon.
    try {
      await deps.clearState(statePath);
    } catch (error) {
      deps.stderr(
        `tlbx serve: failed to clear stale state at ${statePath}: ${errorMessage(error)}\n`,
      );
      return 1;
    }
  }

  // Resolve the entry script before opening the log fd: it can throw on an
  // unusual launch (no `argv[1]`), and we don't want that path to leak the fd.
  let entry: string;
  try {
    entry = deps.resolveEntryScript();
  } catch (error) {
    deps.stderr(`tlbx serve: failed to resolve CLI entry script: ${errorMessage(error)}\n`);
    return 1;
  }

  let logFd: number;
  try {
    logFd = await deps.openLogFd(logPath);
  } catch (error) {
    deps.stderr(`tlbx serve: failed to open log file ${logPath}: ${errorMessage(error)}\n`);
    return 1;
  }

  const childArgs = buildChildArgs(options, configPath);
  // The child publishes the state file itself once it has bound the listener,
  // so pass the paths through the environment rather than writing state here.
  const childEnv: NodeJS.ProcessEnv = {
    ...deps.processEnv,
    [SERVE_STATE_PATH_ENV]: statePath,
    [SERVE_LOG_PATH_ENV]: logPath,
  };
  if (options.forceHttp === true) {
    // Reachable only from the run-spawn path; carries the HTTP-force override
    // to the child without exposing it as a CLI flag.
    childEnv[SERVE_FORCE_HTTP_ENV] = '1';
  }

  let child: SpawnedChildHandle;
  try {
    child = deps.spawn(deps.nodeExecPath(), [entry, ...childArgs], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv,
    });
  } catch (error) {
    await deps.closeFd(logFd);
    deps.stderr(`tlbx serve: failed to spawn background process: ${errorMessage(error)}\n`);
    return 1;
  }

  // The child has its own copy of the log fd now — release ours so the parent
  // does not keep the inode open after exit.
  await deps.closeFd(logFd);

  const pid = child.pid;
  if (pid === undefined) {
    deps.stderr('tlbx serve: spawn did not return a pid\n');
    return 1;
  }

  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  child.unref();

  const outcome = await waitForChildState(
    { childPid: pid, statePath, endpoint, exitInfo: () => exitInfo },
    deps,
  );

  switch (outcome.kind) {
    case 'started': {
      const stopHint =
        options.config !== undefined && options.config.length > 0
          ? `tlbx stop --config ${configPath}`
          : 'tlbx stop';
      deps.stdout(`tlbx serve: started (pid ${String(pid)}) on ${outcome.state.url ?? endpoint}\n`);
      deps.stdout(`logs: ${logPath}\n`);
      deps.stdout(`state: ${statePath}\n`);
      deps.stdout(`stop with: ${stopHint}\n`);
      return 0;
    }
    case 'reused': {
      deps.stdout(
        `tlbx serve: reusing running daemon (pid ${String(outcome.state.pid)}) on ${outcome.state.url ?? endpoint}\n`,
      );
      return 0;
    }
    case 'collision': {
      deps.stderr(
        `tlbx serve: cannot bind ${endpoint}: the port is held by another process (a ToolBox daemon for a different config, or a foreign process). Stop it or change server.http.port.\n`,
      );
      return 1;
    }
    case 'timeout': {
      deps.stderr(
        `tlbx serve: daemon did not become ready within ${String(deps.readinessTimeoutMs)}ms; see ${logPath} and run \`tlbx doctor\`\n`,
      );
      return 1;
    }
    case 'died': {
      const detail = describeExit(exitInfo);
      deps.stderr(`tlbx serve: background process died (${detail}); see ${logPath} for details\n`);
      return 1;
    }
  }
}

function describeExit(info: { code: number | null; signal: NodeJS.Signals | null } | null): string {
  if (info === null) {
    return 'unknown reason';
  }
  if (info.code !== null) {
    return `exit code ${String(info.code)}`;
  }
  if (info.signal !== null) {
    return `signal ${info.signal}`;
  }
  return 'unknown reason';
}
