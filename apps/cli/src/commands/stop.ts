import * as path from 'node:path';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  clearServeState,
  isProcessAlive,
  readServeState,
  resolveConfigPath,
  serveDaemonPathsForConfig,
  type ServeDaemonPaths,
  type ServeDaemonState,
} from '@toolbox/core';

export interface StopOptions {
  config?: string;
}

export interface StopDeps {
  resolvePath: () => string;
  resolveDaemonPaths: (configPath: string) => ServeDaemonPaths;
  readState: (statePath: string) => Promise<ServeDaemonState | null>;
  clearState: (statePath: string) => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  /** Total time we wait for SIGTERM to be honored before escalating. */
  termTimeoutMs: number;
  /** Total time we wait after SIGKILL for the process to actually disappear. */
  killTimeoutMs: number;
  /** Poll interval used while waiting for the child to exit. */
  pollIntervalMs: number;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

export function defaultStopDeps(): StopDeps {
  return {
    resolvePath: () => resolveConfigPath(),
    resolveDaemonPaths: (configPath) => serveDaemonPathsForConfig(configPath),
    readState: (p) => readServeState(p),
    clearState: (p) => clearServeState(p),
    isProcessAlive: (pid) => isProcessAlive(pid),
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    termTimeoutMs: 5_000,
    killTimeoutMs: 2_000,
    pollIntervalMs: 100,
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

async function waitForExit(
  pid: number,
  timeoutMs: number,
  deps: Pick<StopDeps, 'isProcessAlive' | 'sleep' | 'pollIntervalMs'>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!deps.isProcessAlive(pid)) {
      return true;
    }
    await deps.sleep(deps.pollIntervalMs);
  }
  return !deps.isProcessAlive(pid);
}

export async function runStop(options: StopOptions, deps: StopDeps): Promise<number> {
  const configPath =
    options.config !== undefined && options.config.length > 0
      ? path.resolve(options.config)
      : deps.resolvePath();
  const { statePath } = deps.resolveDaemonPaths(configPath);

  let state: ServeDaemonState | null;
  try {
    state = await deps.readState(statePath);
  } catch (error) {
    deps.stderr(`tlbx stop: failed to read state file ${statePath}: ${errorMessage(error)}\n`);
    return 1;
  }

  if (state === null) {
    deps.stdout('tlbx stop: not running\n');
    return 0;
  }

  if (!deps.isProcessAlive(state.pid)) {
    try {
      await deps.clearState(statePath);
    } catch (error) {
      deps.stderr(
        `tlbx stop: failed to clear stale state file ${statePath}: ${errorMessage(error)}\n`,
      );
      return 1;
    }
    deps.stdout(`tlbx stop: not running (cleared stale state for pid ${String(state.pid)})\n`);
    return 0;
  }

  try {
    deps.kill(state.pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ESRCH') {
      // Race: the process died between our liveness check and the signal.
      await deps.clearState(statePath).catch(() => undefined);
      deps.stdout(`tlbx stop: not running (cleared stale state for pid ${String(state.pid)})\n`);
      return 0;
    }
    deps.stderr(`tlbx stop: failed to signal pid ${String(state.pid)}: ${errorMessage(error)}\n`);
    return 1;
  }

  const stopped = await waitForExit(state.pid, deps.termTimeoutMs, deps);
  if (stopped) {
    await deps.clearState(statePath).catch(() => undefined);
    deps.stdout(`tlbx stop: stopped (pid ${String(state.pid)})\n`);
    return 0;
  }

  // Escalate to SIGKILL.
  try {
    deps.kill(state.pid, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ESRCH') {
      deps.stderr(
        `tlbx stop: failed to SIGKILL pid ${String(state.pid)}: ${errorMessage(error)}\n`,
      );
      return 1;
    }
  }

  const killed = await waitForExit(state.pid, deps.killTimeoutMs, deps);
  if (!killed) {
    deps.stderr(
      `tlbx stop: pid ${String(state.pid)} is still alive after SIGKILL; leaving state file in place\n`,
    );
    return 1;
  }

  await deps.clearState(statePath).catch(() => undefined);
  deps.stdout(`tlbx stop: force-killed (pid ${String(state.pid)})\n`);
  return 0;
}

export function stopCommand(): CommandUnknownOpts {
  return new Command('stop')
    .description('Stop a ToolBox gateway started with `tlbx serve --detach`.')
    .option('-c, --config <path>', 'override the resolved config path for this run')
    .action(async (opts) => {
      const code = await runStop(opts, defaultStopDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
