import { spawn, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  clearServeState,
  isProcessAlive,
  loadConfig,
  readServeState,
  resolveConfigPath,
  serveDaemonPathsForConfig,
  writeServeState,
  type LogFormat,
  type LogLevel,
  type ServeDaemonPaths,
  type ServeDaemonState,
  type ToolBoxConfig,
} from '@toolbox/core';

export interface ServeDetachOptions {
  stdio?: boolean;
  http?: boolean;
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
  writeState: (statePath: string, state: ServeDaemonState) => Promise<void>;
  clearState: (statePath: string) => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  openLogFd: (logPath: string) => Promise<number>;
  closeFd: (fd: number) => Promise<void>;
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedChildHandle;
  /**
   * Signals an already-spawned child by pid. Used to tear down an
   * orphaned background process when state persistence fails after spawn.
   */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Resolves the CLI entry script the child should run (`process.argv[1]`). */
  resolveEntryScript: () => string;
  /** Path to the Node binary the child should run under (`process.execPath`). */
  nodeExecPath: () => string;
  /** Inherited env handed to the child. */
  processEnv: NodeJS.ProcessEnv;
  /** Short post-spawn delay (ms) before re-checking the child is alive. */
  startupGraceMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

export function defaultServeDetachDeps(): ServeDetachDeps {
  return {
    resolvePath: () => resolveConfigPath(),
    loadConfig: (p) => loadConfig(p),
    resolveDaemonPaths: (configPath) => serveDaemonPathsForConfig(configPath),
    readState: (p) => readServeState(p),
    writeState: (p, state) => writeServeState(p, state),
    clearState: (p) => clearServeState(p),
    isProcessAlive: (pid) => isProcessAlive(pid),
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
    startupGraceMs: 200,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    now: () => new Date(),
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

function buildEndpointUrl(http: ToolBoxConfig['server']['http']): string {
  const host = http.host === '::1' ? '[::1]' : http.host;
  return `http://${host}:${String(http.port)}${http.path}`;
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

  if (!config.server.http.enabled) {
    deps.stderr(
      'tlbx serve: --detach requires server.http.enabled in config; enable it first or run in foreground\n',
    );
    return 1;
  }

  const { statePath, logPath } = deps.resolveDaemonPaths(configPath);

  const existing = await deps.readState(statePath);
  if (existing !== null) {
    if (deps.isProcessAlive(existing.pid)) {
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

  let child: SpawnedChildHandle;
  try {
    child = deps.spawn(deps.nodeExecPath(), [entry, ...childArgs], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: deps.processEnv,
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

  // Detect immediate-exit before we record state.
  interface ExitInfo {
    code: number | null;
    signal: NodeJS.Signals | null;
  }
  let exitInfo: ExitInfo | null = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  child.unref();

  await deps.sleep(deps.startupGraceMs);

  if (exitInfo !== null || !deps.isProcessAlive(pid)) {
    const detail = describeExit(exitInfo);
    await deps.clearState(statePath).catch(() => undefined);
    deps.stderr(
      `tlbx serve: background process died immediately (${detail}); see ${logPath} for details\n`,
    );
    return 1;
  }

  const url = buildEndpointUrl(config.server.http);
  const state: ServeDaemonState = {
    version: 1,
    pid,
    mode: 'http',
    url,
    logPath,
    startedAt: deps.now().toISOString(),
  };
  try {
    await deps.writeState(statePath, state);
  } catch (error) {
    // We have a running, unrecorded child. Without state, `tlbx stop` cannot
    // find it and a second `tlbx serve --detach` will collide on the port,
    // so tear the orphan down before reporting failure.
    try {
      deps.kill(pid, 'SIGTERM');
    } catch {
      // best-effort: pid may already be gone (ESRCH) or unreachable.
    }
    deps.stderr(`tlbx serve: failed to write state file ${statePath}: ${errorMessage(error)}\n`);
    return 1;
  }

  const stopHint =
    options.config !== undefined && options.config.length > 0
      ? `tlbx stop --config ${configPath}`
      : 'tlbx stop';
  deps.stdout(`tlbx serve: started (pid ${String(pid)}) on ${url}\n`);
  deps.stdout(`logs: ${logPath}\n`);
  deps.stdout(`state: ${statePath}\n`);
  deps.stdout(`stop with: ${stopHint}\n`);
  return 0;
}
