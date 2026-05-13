import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';

import { DEFAULT_CONFIG, type ServeDaemonState, type ToolBoxConfig } from '@toolbox/core';
import { describe, expect, it } from 'vitest';

import {
  runServeDetached,
  type ServeDetachDeps,
  type SpawnedChildHandle,
} from '../serve-detach.js';

interface FakeChildOptions {
  /** Pid returned from `spawn`. */
  pid?: number;
}

interface FakeChildHandle extends SpawnedChildHandle {
  emitter: EventEmitter;
  unrefCalls: number;
}

function makeFakeChild(opts: FakeChildOptions = {}): FakeChildHandle {
  const emitter = new EventEmitter();
  let unrefCalls = 0;
  const handle: FakeChildHandle = {
    pid: opts.pid ?? 9999,
    emitter,
    get unrefCalls() {
      return unrefCalls;
    },
    unref() {
      unrefCalls += 1;
    },
    on: (event, listener) => {
      emitter.on(event, listener as (...args: unknown[]) => void);
    },
  };
  return handle;
}

interface Stub {
  config?: ToolBoxConfig;
  loadConfigError?: Error;
  existingState?: ServeDaemonState | null;
  existingStateAlive?: boolean;
  spawnHandle?: FakeChildHandle;
  spawnError?: Error;
  isAliveOverride?: (pid: number) => boolean;
  writeStateError?: Error;
  clearStateError?: Error;
  openLogFdError?: Error;
  resolvedConfigPath?: string;
  entryScript?: string;
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

interface Harness {
  deps: ServeDetachDeps;
  stdout: { value: string };
  stderr: { value: string };
  spawnCalls: SpawnCall[];
  writeStateCalls: Array<{ path: string; state: ServeDaemonState }>;
  clearStateCalls: string[];
  closedFds: number[];
  childHandle: FakeChildHandle;
}

function makeHarness(stub: Stub = {}): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const spawnCalls: SpawnCall[] = [];
  const writeStateCalls: Array<{ path: string; state: ServeDaemonState }> = [];
  const clearStateCalls: string[] = [];
  const closedFds: number[] = [];
  const childHandle = stub.spawnHandle ?? makeFakeChild();
  const config: ToolBoxConfig = stub.config ?? DEFAULT_CONFIG;

  const deps: ServeDetachDeps = {
    resolvePath: () => '/resolved/config.json',
    loadConfig: () =>
      stub.loadConfigError ? Promise.reject(stub.loadConfigError) : Promise.resolve(config),
    resolveDaemonPaths: (configPath) => ({
      statePath: `${configPath}.state`,
      logPath: `${configPath}.log`,
    }),
    readState: () => Promise.resolve(stub.existingState ?? null),
    writeState: (p, state) => {
      writeStateCalls.push({ path: p, state });
      if (stub.writeStateError) {
        return Promise.reject(stub.writeStateError);
      }
      return Promise.resolve();
    },
    clearState: (p) => {
      clearStateCalls.push(p);
      if (stub.clearStateError) {
        return Promise.reject(stub.clearStateError);
      }
      return Promise.resolve();
    },
    isProcessAlive: stub.isAliveOverride ?? (() => true),
    openLogFd: () => {
      if (stub.openLogFdError) {
        return Promise.reject(stub.openLogFdError);
      }
      return Promise.resolve(42);
    },
    closeFd: (fd) => {
      closedFds.push(fd);
      return Promise.resolve();
    },
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      if (stub.spawnError) {
        throw stub.spawnError;
      }
      return childHandle;
    },
    resolveEntryScript: () => stub.entryScript ?? '/path/to/cli/dist/index.js',
    nodeExecPath: () => '/path/to/node',
    processEnv: { TOOLBOX_TEST: '1' },
    startupGraceMs: 1,
    sleep: () => Promise.resolve(),
    now: () => new Date('2026-05-13T12:00:00.000Z'),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
  };

  return {
    deps,
    stdout,
    stderr,
    spawnCalls,
    writeStateCalls,
    clearStateCalls,
    closedFds,
    childHandle,
  };
}

describe('runServeDetached', () => {
  it('exits 2 when --stdio is combined with --detach', async () => {
    const h = makeHarness();

    const code = await runServeDetached({ stdio: true }, h.deps);

    expect(code).toBe(2);
    expect(h.stderr.value).toMatch(/mutually exclusive/);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('refuses when an alive daemon is already recorded', async () => {
    const h = makeHarness({
      existingState: {
        version: 1,
        pid: 4242,
        mode: 'http',
        url: 'http://127.0.0.1:7331/mcp',
        logPath: '/tmp/serve.log',
        startedAt: '2026-05-12T00:00:00.000Z',
      },
      isAliveOverride: (pid) => pid === 4242,
    });

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/already running/);
    expect(h.stderr.value).toMatch(/4242/);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('clears stale state when the recorded pid is dead and proceeds to spawn', async () => {
    const h = makeHarness({
      existingState: {
        version: 1,
        pid: 4242,
        mode: 'http',
        url: 'http://127.0.0.1:7331/mcp',
        logPath: '/tmp/serve.log',
        startedAt: '2026-05-12T00:00:00.000Z',
      },
      isAliveOverride: (pid) => pid !== 4242, // only the stale pid is dead
    });

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(0);
    expect(h.clearStateCalls).toContain('/resolved/config.json.state');
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.writeStateCalls).toHaveLength(1);
  });

  it('builds the correct spawn argv (entry, --http, --config, log/format passthrough)', async () => {
    const h = makeHarness();

    const code = await runServeDetached({ logLevel: 'debug', logFormat: 'json' }, h.deps);

    expect(code).toBe(0);
    const call = h.spawnCalls[0];
    expect(call).toBeDefined();
    expect(call?.command).toBe('/path/to/node');
    expect(call?.args).toEqual([
      '/path/to/cli/dist/index.js',
      'serve',
      '--http',
      '--config',
      '/resolved/config.json',
      '--log-level',
      'debug',
      '--log-format',
      'json',
    ]);
    expect(call?.options.detached).toBe(true);
    expect(call?.options.stdio).toEqual(['ignore', 42, 42]);
  });

  it('passes through --config to the child', async () => {
    const h = makeHarness();

    await runServeDetached({ config: '/custom/cfg.json' }, h.deps);

    const call = h.spawnCalls[0];
    expect(call?.args).toContain('/custom/cfg.json');
  });

  it('writes the state file with pid, url, logPath, startedAt', async () => {
    const h = makeHarness();

    await runServeDetached({}, h.deps);

    expect(h.writeStateCalls).toHaveLength(1);
    const written = h.writeStateCalls[0];
    expect(written?.path).toBe('/resolved/config.json.state');
    expect(written?.state).toEqual({
      version: 1,
      pid: 9999,
      mode: 'http',
      url: 'http://127.0.0.1:7331/mcp',
      logPath: '/resolved/config.json.log',
      startedAt: '2026-05-13T12:00:00.000Z',
    });
  });

  it('reports the pid, endpoint, and log path on stdout', async () => {
    const h = makeHarness();

    await runServeDetached({}, h.deps);

    expect(h.stdout.value).toMatch(/pid 9999/);
    expect(h.stdout.value).toMatch(/http:\/\/127\.0\.0\.1:7331\/mcp/);
    expect(h.stdout.value).toMatch(/\/resolved\/config\.json\.log/);
    expect(h.stdout.value).toMatch(/tlbx stop/);
  });

  it('refuses to fork when server.http.enabled is false', async () => {
    const config: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      server: { ...DEFAULT_CONFIG.server, http: { ...DEFAULT_CONFIG.server.http, enabled: false } },
    };
    const h = makeHarness({ config });

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/http\.enabled/);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('returns 1 and surfaces the config error when loadConfig rejects', async () => {
    const h = makeHarness({ loadConfigError: new Error('not json') });

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/failed to load config/);
    expect(h.stderr.value).toMatch(/not json/);
  });

  it('reports failure and clears state when the child exits immediately', async () => {
    const fakeChild = makeFakeChild({ pid: 5555 });
    const h = makeHarness({
      spawnHandle: fakeChild,
      // The child is reported alive at the initial existence check (none),
      // then `isAliveOverride` returns false after the grace window.
      isAliveOverride: () => false,
    });

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/background process died/);
    expect(h.clearStateCalls).toEqual(['/resolved/config.json.state']);
    expect(h.writeStateCalls).toHaveLength(0);
  });

  it('unrefs the child so the parent can exit independently', async () => {
    const fakeChild = makeFakeChild({ pid: 7777 });
    const h = makeHarness({ spawnHandle: fakeChild });

    await runServeDetached({}, h.deps);

    expect(fakeChild.unrefCalls).toBe(1);
  });

  it('closes the parent copy of the log fd after spawn', async () => {
    const h = makeHarness();

    await runServeDetached({}, h.deps);

    expect(h.closedFds).toContain(42);
  });

  it('formats IPv6 loopback host as [::1] in the recorded URL', async () => {
    const config: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      server: {
        ...DEFAULT_CONFIG.server,
        http: { ...DEFAULT_CONFIG.server.http, host: '::1' },
      },
    };
    const h = makeHarness({ config });

    await runServeDetached({}, h.deps);

    const url = h.writeStateCalls[0]?.state.url ?? '';
    expect(url).toMatch(/\[::1\]/);
  });
});
