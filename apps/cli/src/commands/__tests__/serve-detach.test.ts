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

function makeState(overrides: Partial<ServeDaemonState> = {}): ServeDaemonState {
  return {
    version: 1,
    pid: 9999,
    mode: 'http',
    url: 'http://127.0.0.1:7331/mcp',
    logPath: '/resolved/config.json.log',
    startedAt: '2026-05-25T12:00:00.000Z',
    ...overrides,
  };
}

interface Stub {
  config?: ToolBoxConfig;
  loadConfigError?: Error;
  /** Sequence of readState responses, consumed in order (defaults to null). */
  readStateResponses?: Array<ServeDaemonState | null>;
  probeReady?: boolean;
  spawnHandle?: FakeChildHandle;
  spawnError?: Error;
  isAliveOverride?: (pid: number) => boolean;
  clearStateError?: Error;
  openLogFdError?: Error;
  entryScript?: string;
  killError?: Error;
  readinessTimeoutMs?: number;
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
  clearStateCalls: string[];
  killCalls: Array<{ pid: number; signal: NodeJS.Signals }>;
  closedFds: number[];
  childHandle: FakeChildHandle;
  readStateCalls: number;
}

function makeHarness(stub: Stub = {}): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const spawnCalls: SpawnCall[] = [];
  const clearStateCalls: string[] = [];
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const closedFds: number[] = [];
  const childHandle = stub.spawnHandle ?? makeFakeChild();
  const config: ToolBoxConfig = stub.config ?? DEFAULT_CONFIG;
  const readStateResponses = stub.readStateResponses ?? [];
  let readStateCalls = 0;
  let clock = 0;

  const deps: ServeDetachDeps = {
    resolvePath: () => '/resolved/config.json',
    loadConfig: () =>
      stub.loadConfigError ? Promise.reject(stub.loadConfigError) : Promise.resolve(config),
    resolveDaemonPaths: (configPath) => ({
      statePath: `${configPath}.state`,
      logPath: `${configPath}.log`,
    }),
    readState: () => {
      const response = readStateResponses[readStateCalls] ?? null;
      readStateCalls += 1;
      return Promise.resolve(response);
    },
    clearState: (p) => {
      clearStateCalls.push(p);
      if (stub.clearStateError) {
        return Promise.reject(stub.clearStateError);
      }
      return Promise.resolve();
    },
    isProcessAlive: stub.isAliveOverride ?? (() => true),
    probeReady: () => Promise.resolve(stub.probeReady ?? false),
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
    kill: (pid, signal) => {
      killCalls.push({ pid, signal });
      if (stub.killError) {
        throw stub.killError;
      }
    },
    resolveEntryScript: () => stub.entryScript ?? '/path/to/cli/dist/index.js',
    nodeExecPath: () => '/path/to/node',
    processEnv: { TOOLBOX_TEST: '1' },
    readinessTimeoutMs: stub.readinessTimeoutMs ?? 1_000,
    pollIntervalMs: 100,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
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
    clearStateCalls,
    killCalls,
    closedFds,
    childHandle,
    get readStateCalls() {
      return readStateCalls;
    },
  };
}

function httpDisabledConfig(): ToolBoxConfig {
  return {
    ...DEFAULT_CONFIG,
    server: {
      ...DEFAULT_CONFIG.server,
      http: { ...DEFAULT_CONFIG.server.http, enabled: false },
    },
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

  it('refuses to fork when server.http.enabled is false (explicit serve --detach)', async () => {
    const h = makeHarness({ config: httpDisabledConfig() });

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/http\.enabled/);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('forces HTTP past the enabled gate via a private env marker, not a CLI flag', async () => {
    const h = makeHarness({
      config: httpDisabledConfig(),
      readStateResponses: [null, makeState()],
    });

    const code = await runServeDetached({ forceHttp: true }, h.deps);

    expect(code).toBe(0);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]?.args).not.toContain('--force-http');
    expect(h.spawnCalls[0]?.options.env).toMatchObject({ TOOLBOX_SERVE_FORCE_HTTP: '1' });
  });

  it('does not set the force-http env marker on the explicit serve --detach path', async () => {
    const h = makeHarness({ readStateResponses: [null, makeState()] });

    await runServeDetached({}, h.deps);

    expect(h.spawnCalls[0]?.options.env).not.toHaveProperty('TOOLBOX_SERVE_FORCE_HTTP');
  });

  it('refuses when an alive daemon is already recorded', async () => {
    const h = makeHarness({
      readStateResponses: [makeState({ pid: 4242 })],
      isAliveOverride: (pid) => pid === 4242,
    });

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/already running/);
    expect(h.stderr.value).toMatch(/4242/);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('reuses an alive daemon instead of erroring on the forceHttp path', async () => {
    const h = makeHarness({
      readStateResponses: [makeState({ pid: 4242 })],
      isAliveOverride: (pid) => pid === 4242,
    });

    const code = await runServeDetached({ forceHttp: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/reusing running daemon \(pid 4242\)/);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('clears stale state when the recorded pid is dead and proceeds to spawn', async () => {
    const h = makeHarness({
      readStateResponses: [makeState({ pid: 4242 }), makeState({ pid: 9999 })],
      isAliveOverride: (pid) => pid !== 4242,
    });

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(0);
    expect(h.clearStateCalls).toContain('/resolved/config.json.state');
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('builds the correct spawn argv and managed-daemon env', async () => {
    const h = makeHarness({ readStateResponses: [null, makeState()] });

    const code = await runServeDetached({ logLevel: 'debug', logFormat: 'json' }, h.deps);

    expect(code).toBe(0);
    const call = h.spawnCalls[0];
    expect(call?.command).toBe('/path/to/node');
    expect(call?.args).toEqual([
      '/path/to/cli/dist/index.js',
      'serve-managed',
      '--http',
      '--config',
      '/resolved/config.json',
      '--log-level',
      'debug',
      '--log-format',
      'json',
    ]);
    expect(call?.options.detached).toBe(true);
    expect(call?.options.stdio).toEqual(['ignore', 42, 42, 'pipe']);
    expect(call?.options.env).toMatchObject({
      TOOLBOX_SERVE_STATE_PATH: '/resolved/config.json.state',
      TOOLBOX_SERVE_LOG_PATH: '/resolved/config.json.log',
    });
  });

  it('reports started, logs, state, and stop hint once the child publishes state', async () => {
    const h = makeHarness({
      readStateResponses: [null, makeState({ pid: 9999, url: 'http://127.0.0.1:7331/mcp' })],
    });

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/started \(pid 9999\)/);
    expect(h.stdout.value).toMatch(/http:\/\/127\.0\.0\.1:7331\/mcp/);
    expect(h.stdout.value).toMatch(/\/resolved\/config\.json\.log/);
    expect(h.stdout.value).toMatch(/\/resolved\/config\.json\.state/);
    expect(h.stdout.value).toMatch(/tlbx stop/);
  });

  it('includes --config in the stop hint and spawn args when one was used', async () => {
    const h = makeHarness({ readStateResponses: [null, makeState()] });

    await runServeDetached({ config: '/custom/cfg.json' }, h.deps);

    expect(h.spawnCalls[0]?.args).toContain('/custom/cfg.json');
    expect(h.stdout.value).toMatch(/tlbx stop --config \/custom\/cfg\.json/);
  });

  it('reuses a sibling that won the port race and tears down our child', async () => {
    const child = makeFakeChild({ pid: 9999 });
    const h = makeHarness({
      spawnHandle: child,
      // existing check → null; first poll → sibling (pid 5555) published.
      readStateResponses: [null, makeState({ pid: 5555 })],
      isAliveOverride: () => true,
    });

    const code = await runServeDetached({ forceHttp: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/reusing running daemon \(pid 5555\)/);
    expect(h.killCalls).toEqual([{ pid: 9999, signal: 'SIGTERM' }]);
  });

  it('reuses a sibling discovered after our child loses the bind', async () => {
    const child = makeFakeChild({ pid: 9999 });
    const h = makeHarness({
      spawnHandle: child,
      // existing → null; poll → null (not published yet); after death recheck → sibling.
      readStateResponses: [null, null, makeState({ pid: 5555 })],
      isAliveOverride: (pid) => pid !== 9999, // our child is dead, sibling alive
      probeReady: true,
    });

    const code = await runServeDetached({ forceHttp: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/reusing running daemon \(pid 5555\)/);
  });

  it('reports a collision when the child cannot bind a foreign-held port', async () => {
    const child = makeFakeChild({ pid: 9999 });
    const h = makeHarness({
      spawnHandle: child,
      readStateResponses: [null, null, null],
      isAliveOverride: (pid) => pid !== 9999, // our child died, nothing else recorded
      probeReady: true, // but the port answers — a foreign process
    });

    const code = await runServeDetached({ forceHttp: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/cannot bind/);
    expect(h.stderr.value).toMatch(/different config, or a foreign process/);
  });

  it('reports a died child when nothing answers the port', async () => {
    const child = makeFakeChild({ pid: 9999 });
    const h = makeHarness({
      spawnHandle: child,
      readStateResponses: [null],
      isAliveOverride: (pid) => pid !== 9999, // our child died
      probeReady: false, // port closed
    });

    const code = await runServeDetached({ forceHttp: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/background process died/);
  });

  it('times out and kills the child when state is never published', async () => {
    const child = makeFakeChild({ pid: 9999 });
    const h = makeHarness({
      spawnHandle: child,
      readStateResponses: [null], // existing check; all later polls default to null
      isAliveOverride: () => true, // child stays alive but never publishes
      readinessTimeoutMs: 300,
    });

    const code = await runServeDetached({ forceHttp: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/did not become ready within 300ms/);
    expect(h.stderr.value).toMatch(/\/resolved\/config\.json\.log/);
    expect(h.killCalls).toEqual([{ pid: 9999, signal: 'SIGTERM' }]);
  });

  it('returns 1 without opening the log fd when resolveEntryScript throws', async () => {
    const h = makeHarness();
    h.deps.resolveEntryScript = () => {
      throw new Error('argv[1] is empty');
    };
    let openedFd = false;
    h.deps.openLogFd = () => {
      openedFd = true;
      return Promise.resolve(42);
    };

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(1);
    expect(openedFd).toBe(false);
    expect(h.stderr.value).toMatch(/failed to resolve CLI entry script/);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('returns 1 and surfaces the config error when loadConfig rejects', async () => {
    const h = makeHarness({ loadConfigError: new Error('not json') });

    const code = await runServeDetached({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/failed to load config/);
    expect(h.stderr.value).toMatch(/not json/);
  });

  it('unrefs the child and closes the parent copy of the log fd', async () => {
    const child = makeFakeChild({ pid: 7777 });
    const h = makeHarness({
      spawnHandle: child,
      readStateResponses: [null, makeState({ pid: 7777 })],
    });

    await runServeDetached({}, h.deps);

    expect(child.unrefCalls).toBe(1);
    expect(h.closedFds).toContain(42);
  });
});
