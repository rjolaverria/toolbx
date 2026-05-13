import { describe, expect, it, vi } from 'vitest';

import type { ServeDaemonPaths, ServeDaemonState } from '@toolbox/core';

import { runStop, type StopDeps } from '../stop.js';

interface StubOpts {
  state?: ServeDaemonState | null;
  /** Pids that are alive at the start of the test. */
  alivePids?: ReadonlyArray<number>;
  /** When a pid receives this many SIGTERMs without dying, returns false to alive checks. */
  killAfterTermCount?: number;
  /** If true, SIGTERM is honored but only after `killAfterTermCount` sleeps. */
  ignoreSigterm?: boolean;
  /** Mode: 'graceful' (dies after first SIGTERM), 'force' (only SIGKILL works), 'stuck' (nothing works). */
  killBehavior?: 'graceful' | 'force' | 'stuck';
  termBehaviorError?: NodeJS.ErrnoException;
  killBehaviorError?: NodeJS.ErrnoException;
  readStateError?: Error;
  clearStateError?: Error;
}

interface Harness {
  deps: StopDeps;
  stdout: { value: string };
  stderr: { value: string };
  readState: ReturnType<typeof vi.fn>;
  clearState: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  sleeps: number[];
}

function makeHarness(opts: StubOpts = {}): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const sleeps: number[] = [];
  const alivePids = new Set<number>(opts.alivePids ?? []);

  const behavior = opts.killBehavior ?? 'graceful';

  const readState = vi.fn((): Promise<ServeDaemonState | null> => {
    if (opts.readStateError) {
      return Promise.reject(opts.readStateError);
    }
    return Promise.resolve(opts.state ?? null);
  });

  const clearState = vi.fn((): Promise<void> => {
    if (opts.clearStateError) {
      return Promise.reject(opts.clearStateError);
    }
    return Promise.resolve();
  });

  const kill = vi.fn((pid: number, signal: NodeJS.Signals): void => {
    if (signal === 'SIGTERM') {
      if (opts.termBehaviorError) {
        throw opts.termBehaviorError;
      }
      if (behavior === 'graceful') {
        alivePids.delete(pid);
      }
      // 'force' or 'stuck': pid stays alive after SIGTERM.
      return;
    }
    if (signal === 'SIGKILL') {
      if (opts.killBehaviorError) {
        throw opts.killBehaviorError;
      }
      if (behavior !== 'stuck') {
        alivePids.delete(pid);
      }
      return;
    }
  });

  const deps: StopDeps = {
    resolvePath: () => '/resolved/config.json',
    resolveDaemonPaths: (configPath): ServeDaemonPaths => ({
      statePath: `${configPath}.state`,
      logPath: `${configPath}.log`,
    }),
    readState,
    clearState,
    isProcessAlive: (pid) => alivePids.has(pid),
    kill,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    termTimeoutMs: 20,
    killTimeoutMs: 10,
    pollIntervalMs: 5,
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
  };

  return { deps, stdout, stderr, readState, clearState, kill, sleeps };
}

function makeState(overrides: Partial<ServeDaemonState> = {}): ServeDaemonState {
  return {
    version: 1,
    pid: 4242,
    mode: 'http',
    url: 'http://127.0.0.1:7331/mcp',
    logPath: '/tmp/serve.log',
    startedAt: '2026-05-13T12:00:00.000Z',
    ...overrides,
  };
}

describe('runStop', () => {
  it('reports not-running and exits 0 when there is no state file', async () => {
    const h = makeHarness({ state: null });

    const code = await runStop({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/not running/);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.clearState).not.toHaveBeenCalled();
  });

  it('clears a stale state file (pid not alive) and exits 0', async () => {
    const h = makeHarness({ state: makeState({ pid: 99 }), alivePids: [] });

    const code = await runStop({}, h.deps);

    expect(code).toBe(0);
    expect(h.clearState).toHaveBeenCalledTimes(1);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.stdout.value).toMatch(/not running/);
    expect(h.stdout.value).toMatch(/99/);
  });

  it('sends SIGTERM, observes exit, and clears state', async () => {
    const h = makeHarness({
      state: makeState({ pid: 100 }),
      alivePids: [100],
      killBehavior: 'graceful',
    });

    const code = await runStop({}, h.deps);

    expect(code).toBe(0);
    expect(h.kill).toHaveBeenCalledWith(100, 'SIGTERM');
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.clearState).toHaveBeenCalledTimes(1);
    expect(h.stdout.value).toMatch(/stopped/);
  });

  it('escalates to SIGKILL when SIGTERM is not honored', async () => {
    const h = makeHarness({
      state: makeState({ pid: 100 }),
      alivePids: [100],
      killBehavior: 'force',
    });

    const code = await runStop({}, h.deps);

    expect(code).toBe(0);
    expect(h.kill).toHaveBeenNthCalledWith(1, 100, 'SIGTERM');
    expect(h.kill).toHaveBeenNthCalledWith(2, 100, 'SIGKILL');
    expect(h.clearState).toHaveBeenCalledTimes(1);
    expect(h.stdout.value).toMatch(/force-killed/);
  });

  it('reports an error and keeps state when SIGKILL also fails to kill', async () => {
    const h = makeHarness({
      state: makeState({ pid: 100 }),
      alivePids: [100],
      killBehavior: 'stuck',
    });

    const code = await runStop({}, h.deps);

    expect(code).toBe(1);
    expect(h.kill).toHaveBeenCalledWith(100, 'SIGKILL');
    expect(h.clearState).not.toHaveBeenCalled();
    expect(h.stderr.value).toMatch(/still alive after SIGKILL/);
  });

  it('handles a SIGTERM that returns ESRCH (process died mid-call) as a stop', async () => {
    const err = new Error('no such process') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    const h = makeHarness({
      state: makeState({ pid: 100 }),
      alivePids: [100],
      termBehaviorError: err,
    });

    const code = await runStop({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/not running/);
    expect(h.clearState).toHaveBeenCalledTimes(1);
  });

  it('surfaces clearState errors after a successful SIGTERM stop', async () => {
    const h = makeHarness({
      state: makeState({ pid: 100 }),
      alivePids: [100],
      killBehavior: 'graceful',
      clearStateError: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    });

    const code = await runStop({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/stopped \(pid 100\)/);
    expect(h.stderr.value).toMatch(/failed to clear state file/);
  });

  it('surfaces clearState errors after force-kill', async () => {
    const h = makeHarness({
      state: makeState({ pid: 100 }),
      alivePids: [100],
      killBehavior: 'force',
      clearStateError: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    });

    const code = await runStop({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/force-killed/);
    expect(h.stderr.value).toMatch(/failed to clear state file/);
  });

  it('surfaces clearState errors on the SIGTERM ESRCH race path', async () => {
    const err = new Error('no such process') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    const h = makeHarness({
      state: makeState({ pid: 100 }),
      alivePids: [100],
      termBehaviorError: err,
      clearStateError: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    });

    const code = await runStop({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/not running/);
    expect(h.stderr.value).toMatch(/failed to clear state file/);
  });

  it('honors --config when resolving the state file path', async () => {
    const h = makeHarness({ state: null });
    const customResolveDaemonPaths = vi.fn((configPath: string) => ({
      statePath: `${configPath}.state`,
      logPath: `${configPath}.log`,
    }));
    h.deps.resolveDaemonPaths = customResolveDaemonPaths;

    await runStop({ config: '/elsewhere/config.json' }, h.deps);

    expect(customResolveDaemonPaths).toHaveBeenCalledWith('/elsewhere/config.json');
  });
});
