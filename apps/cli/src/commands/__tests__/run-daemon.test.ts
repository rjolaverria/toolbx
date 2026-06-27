import {
  computeConfigIdentity,
  DEFAULT_CONFIG,
  type ServeDaemonState,
  type ToolbxConfig,
} from '@toolbx/core';
import { describe, expect, it, vi } from 'vitest';

import {
  defaultEnsureDaemonDeps,
  ensureDaemon,
  type ColdStartResult,
  type EnsureDaemonDeps,
} from '../run-daemon.js';
import type { ServeDetachOptions } from '../serve-detach.js';

function makeState(overrides: Partial<ServeDaemonState> = {}): ServeDaemonState {
  return {
    version: 1,
    pid: 9999,
    mode: 'http',
    url: 'http://127.0.0.1:7331/mcp',
    logPath: '/resolved/config.json.log',
    startedAt: '2026-05-25T12:00:00.000Z',
    // Default to the identity of the harness's default config so reuse tests
    // pass the drift check; tests that exercise drift override this.
    configHash: computeConfigIdentity(DEFAULT_CONFIG),
    ...overrides,
  };
}

interface Stub {
  config?: ToolbxConfig;
  loadConfigError?: Error;
  readStateResponses?: Array<ServeDaemonState | null>;
  isAliveOverride?: (pid: number) => boolean;
  waitForReady?: boolean | boolean[];
  clearStateError?: Error;
  coldStart?: ColdStartResult;
}

interface Harness {
  deps: EnsureDaemonDeps;
  coldStartCalls: ServeDetachOptions[];
  clearStateCalls: string[];
  readStateCalls: () => number;
  waitForReadyCalls: string[];
}

function makeHarness(stub: Stub = {}): Harness {
  const config = stub.config ?? DEFAULT_CONFIG;
  const readStateResponses = stub.readStateResponses ?? [];
  let readStateCalls = 0;
  const coldStartCalls: ServeDetachOptions[] = [];
  const clearStateCalls: string[] = [];
  const waitForReadyCalls: string[] = [];
  let waitCall = 0;

  const deps: EnsureDaemonDeps = {
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
    waitForReady: (url) => {
      waitForReadyCalls.push(url);
      const r = stub.waitForReady ?? true;
      const result = Array.isArray(r) ? (r[waitCall] ?? false) : r;
      waitCall += 1;
      return Promise.resolve(result);
    },
    coldStart: (options) => {
      coldStartCalls.push(options);
      return Promise.resolve(stub.coldStart ?? { code: 0, diagnostic: '' });
    },
  };

  return {
    deps,
    coldStartCalls,
    clearStateCalls,
    readStateCalls: () => readStateCalls,
    waitForReadyCalls,
  };
}

function httpDisabledConfig(): ToolbxConfig {
  return {
    ...DEFAULT_CONFIG,
    server: {
      ...DEFAULT_CONFIG.server,
      http: { ...DEFAULT_CONFIG.server.http, enabled: false },
    },
  };
}

describe('ensureDaemon', () => {
  it('cold-starts a daemon when none is running and returns a ready endpoint', async () => {
    const h = makeHarness({
      // existing check → null; post-start read → published state.
      readStateResponses: [null, makeState({ pid: 4242 })],
    });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.daemon).toEqual({
        url: 'http://127.0.0.1:7331/mcp',
        pid: 4242,
        reused: false,
        configPath: '/resolved/config.json',
        statePath: '/resolved/config.json.state',
        logPath: '/resolved/config.json.log',
        config: DEFAULT_CONFIG,
      });
    }
    expect(h.coldStartCalls).toHaveLength(1);
  });

  it('reuses a healthy daemon for the same config without spawning a second', async () => {
    const h = makeHarness({
      readStateResponses: [makeState({ pid: 4242 })],
      isAliveOverride: (pid) => pid === 4242,
      waitForReady: true,
    });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.daemon.reused).toBe(true);
      expect(result.daemon.pid).toBe(4242);
    }
    expect(h.coldStartCalls).toHaveLength(0);
  });

  it('refuses a reused daemon whose recorded config identity has drifted', async () => {
    const h = makeHarness({
      readStateResponses: [makeState({ pid: 4242, configHash: 'stale-hash-from-an-older-config' })],
      isAliveOverride: (pid) => pid === 4242,
      waitForReady: true,
    });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/different config/);
      expect(result.message).toMatch(/tlbx stop/);
    }
    // The drift is detected before any readiness probe or cold-start.
    expect(h.waitForReadyCalls).toHaveLength(0);
    expect(h.coldStartCalls).toHaveLength(0);
  });

  it('forces HTTP on for the cold-start even when server.http.enabled is false', async () => {
    const h = makeHarness({
      config: httpDisabledConfig(),
      // The daemon that bound the port publishes the identity of the config it
      // actually loaded — here, the same http-disabled config.
      readStateResponses: [
        null,
        makeState({ configHash: computeConfigIdentity(httpDisabledConfig()) }),
      ],
    });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(true);
    expect(h.coldStartCalls[0]?.forceHttp).toBe(true);
  });

  it('refuses after cold-start when the bound daemon published a different config identity', async () => {
    // A concurrent starter could win the port with a different snapshot, or the
    // file could change between the pre-spawn load and the child's startup.
    const h = makeHarness({
      readStateResponses: [
        null,
        makeState({ pid: 4242, configHash: 'a-different-config-identity' }),
      ],
    });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/different config/);
      expect(result.message).toMatch(/tlbx stop/);
    }
  });

  it('clears stale state before cold-starting', async () => {
    const h = makeHarness({
      readStateResponses: [makeState({ pid: 1111 }), makeState({ pid: 4242 })],
      isAliveOverride: (pid) => pid !== 1111, // recorded pid is dead
    });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(true);
    expect(h.clearStateCalls).toEqual(['/resolved/config.json.state']);
    expect(h.coldStartCalls).toHaveLength(1);
  });

  it('surfaces a config/port collision from the cold-start diagnostic', async () => {
    const h = makeHarness({
      readStateResponses: [null, null],
      coldStart: {
        code: 1,
        diagnostic:
          'tlbx serve: cannot bind http://127.0.0.1:7331/mcp: the port is held by another process (a Toolbx daemon for a different config, or a foreign process).\n',
      },
    });

    const result = await ensureDaemon({ config: '/other/config.json' }, h.deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(1);
      expect(result.message).toMatch(/cannot bind/);
      expect(result.message).toMatch(/different config, or a foreign process/);
    }
  });

  it('reports a wedged daemon when the recorded pid is alive but unresponsive', async () => {
    const h = makeHarness({
      readStateResponses: [makeState({ pid: 4242 })],
      isAliveOverride: (pid) => pid === 4242,
      waitForReady: false,
    });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/not responding/);
      expect(result.message).toMatch(/tlbx stop/);
    }
    expect(h.coldStartCalls).toHaveLength(0);
  });

  it('reports a readiness timeout when a freshly started daemon never answers', async () => {
    const h = makeHarness({
      readStateResponses: [null, makeState({ pid: 4242 })],
      waitForReady: false,
    });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/did not become ready/);
      expect(result.message).toMatch(/\/resolved\/config\.json\.log/);
    }
  });

  it('reports when the cold-start succeeds but no live state is recorded', async () => {
    const h = makeHarness({
      readStateResponses: [null, null], // nothing published after a 0 exit
    });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/no live state is recorded/);
    }
  });

  it('converges on a concurrent winner reported by the cold-start', async () => {
    // serve-detach reused a sibling (exit 0) and the sibling published state.
    const h = makeHarness({
      readStateResponses: [null, makeState({ pid: 5555 })],
      coldStart: { code: 0, diagnostic: '' },
    });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.daemon.pid).toBe(5555);
    }
  });

  it('resolves an explicit --config to an absolute path', async () => {
    const h = makeHarness({ readStateResponses: [null, makeState()] });

    const result = await ensureDaemon({ config: 'rel/config.json' }, h.deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.daemon.configPath.startsWith('/')).toBe(true);
      expect(result.daemon.configPath.endsWith('rel/config.json')).toBe(true);
    }
  });

  it('surfaces a config load failure', async () => {
    const h = makeHarness({ loadConfigError: new Error('not json') });

    const result = await ensureDaemon({}, h.deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/failed to load config/);
      expect(result.message).toMatch(/not json/);
    }
  });
});

describe('defaultEnsureDaemonDeps', () => {
  it('cold-start captures all daemon output without writing to process stdout', async () => {
    const deps = defaultEnsureDaemonDeps();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      // A missing config makes serve-detach fail fast (before any spawn) and
      // write its diagnostic — which must land in the buffer, not on stdout.
      const result = await deps.coldStart({
        config: '/nonexistent/toolbx-p2-01/config.json',
        forceHttp: true,
      });
      expect(result.code).toBe(1);
      expect(result.diagnostic).toMatch(/failed to load config/);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
