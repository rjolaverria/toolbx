import { EventEmitter } from 'node:events';

import {
  createNoopLogger,
  DEFAULT_CONFIG,
  type CreateLoggerOptions,
  type ServeDaemonState,
  type ToolBoxConfig,
} from '@toolbox/core';
import type {
  CreateDownstreamHttpServerDeps,
  CreateDownstreamStdioServerDeps,
  DownstreamHttpServer,
  DownstreamStdioServer,
  GatewayRuntime,
} from '@toolbox/mcp-gateway';
import { describe, expect, it, vi } from 'vitest';

import { hasManagedChildHandle, resolveForceHttp, runServe, type ServeDeps } from '../serve.js';

interface FakeStdioControls {
  server: DownstreamStdioServer;
  finishDone: () => void;
}

function makeFakeStdio(): FakeStdioControls {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const server: DownstreamStdioServer = {
    server: {} as never,
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    get done() {
      return done;
    },
  };
  return {
    server,
    finishDone: () => resolveDone(),
  };
}

interface FakeHttpControls {
  server: DownstreamHttpServer;
  finishDone: () => void;
  stopSpy: ReturnType<typeof vi.fn>;
}

function makeFakeHttp(url: URL): FakeHttpControls {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const stopSpy = vi.fn(() => Promise.resolve());
  const server: DownstreamHttpServer = {
    get url() {
      return url;
    },
    start: vi.fn(() => Promise.resolve()),
    stop: stopSpy,
    get done() {
      return done;
    },
  };
  return { server, finishDone: () => resolveDone(), stopSpy };
}

interface FakeRuntime {
  runtime: GatewayRuntime;
  disposeSpy: ReturnType<typeof vi.fn>;
  startUpstreamsSpy: ReturnType<typeof vi.fn>;
}

function makeFakeRuntime(): FakeRuntime {
  const startUpstreamsSpy = vi.fn(() => undefined);
  const disposeSpy = vi.fn(() => Promise.resolve());
  const runtime: GatewayRuntime = {
    statusRegistry: {} as never,
    toolRegistry: {} as never,
    upstreams: { get: () => undefined },
    registerHandlers: () => undefined,
    startUpstreams: () => startUpstreamsSpy(),
    notifyAllSessionsToolsChanged: () => undefined,
    dispose: () => disposeSpy(),
  };
  return { runtime, disposeSpy, startUpstreamsSpy };
}

interface Harness {
  deps: ServeDeps;
  stderr: { value: string };
  loadConfig: ReturnType<typeof vi.fn>;
  createRuntime: ReturnType<typeof vi.fn>;
  createStdio: ReturnType<typeof vi.fn>;
  createHttp: ReturnType<typeof vi.fn>;
  createLogger: ReturnType<typeof vi.fn>;
  stdioControls: FakeStdioControls;
  httpControls: FakeHttpControls;
  runtime: GatewayRuntime;
  disposeSpy: ReturnType<typeof vi.fn>;
  startUpstreamsSpy: ReturnType<typeof vi.fn>;
  writeStateSpy: ReturnType<typeof vi.fn>;
  clearStateSpy: ReturnType<typeof vi.fn>;
  readStateSpy: ReturnType<typeof vi.fn>;
}

function makeHarness(config: ToolBoxConfig = DEFAULT_CONFIG): Harness {
  const stderr = { value: '' };
  const stdioControls = makeFakeStdio();
  const httpControls = makeFakeHttp(new URL('http://127.0.0.1:7331/mcp'));
  const fakeRuntime = makeFakeRuntime();
  const { runtime, disposeSpy, startUpstreamsSpy } = fakeRuntime;
  const writeStateSpy = vi.fn<(p: string, s: ServeDaemonState) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const clearStateSpy = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve());
  const readStateSpy = vi.fn<(p: string) => Promise<ServeDaemonState | null>>(() =>
    Promise.resolve(null),
  );

  const loadConfig = vi.fn<(path: string) => Promise<ToolBoxConfig>>(() => Promise.resolve(config));
  const createRuntime = vi.fn<() => GatewayRuntime>(() => runtime);
  const createStdio = vi.fn<(deps: CreateDownstreamStdioServerDeps) => DownstreamStdioServer>(
    () => stdioControls.server,
  );
  const createHttp = vi.fn<(deps: CreateDownstreamHttpServerDeps) => DownstreamHttpServer>(
    () => httpControls.server,
  );
  const createLogger = vi.fn<(options: CreateLoggerOptions) => ReturnType<typeof createNoopLogger>>(
    () => createNoopLogger(),
  );

  const deps: ServeDeps = {
    resolvePath: () => '/resolved/config.json',
    loadConfig,
    createLogger,
    createRuntime,
    createStdio,
    createHttp,
    stderr: (msg) => {
      stderr.value += msg;
    },
    processEnv: { TOOLBOX_TEST: '1' },
    signalProcess: new EventEmitter() as unknown as NodeJS.Process,
    writeServeState: writeStateSpy,
    clearServeState: clearStateSpy,
    readServeState: readStateSpy,
    now: () => new Date('2026-05-25T12:00:00.000Z'),
    pid: () => 4242,
    isManagedChild: () => false,
  };

  return {
    deps,
    stderr,
    loadConfig,
    createRuntime,
    createStdio,
    createHttp,
    createLogger,
    stdioControls,
    httpControls,
    runtime,
    disposeSpy,
    startUpstreamsSpy,
    writeStateSpy,
    clearStateSpy,
    readStateSpy,
  };
}

describe('runServe', () => {
  it('rejects --stdio and --http together with a non-zero exit code', async () => {
    const h = makeHarness();
    const code = await runServe({ stdio: true, http: true }, h.deps);
    expect(code).toBe(2);
    expect(h.stderr.value).toMatch(/mutually exclusive/);
    expect(h.loadConfig).not.toHaveBeenCalled();
  });

  it('defaults to http mode when neither flag is set', async () => {
    const h = makeHarness();
    const promise = runServe({}, h.deps);
    // Allow runServe to reach the await downstream.done
    await Promise.resolve();
    await Promise.resolve();
    h.httpControls.finishDone();
    const code = await promise;

    expect(code).toBe(0);
    expect(h.createHttp).toHaveBeenCalledTimes(1);
    expect(h.createStdio).not.toHaveBeenCalled();
  });

  it('honors --config over the resolved default path', async () => {
    const h = makeHarness();
    const promise = runServe({ stdio: true, config: '/custom/config.json' }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.stdioControls.finishDone();
    await promise;

    expect(h.loadConfig).toHaveBeenCalledWith('/custom/config.json');
  });

  it('falls back to resolvePath() when --config is omitted', async () => {
    const h = makeHarness();
    const promise = runServe({ stdio: true }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.stdioControls.finishDone();
    await promise;

    expect(h.loadConfig).toHaveBeenCalledWith('/resolved/config.json');
  });

  it('forces JSON log format on stderr in stdio mode', async () => {
    const h = makeHarness();
    const promise = runServe({ stdio: true }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.stdioControls.finishDone();
    await promise;

    expect(h.createLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'json',
        destination: 'stderr',
        level: 'info',
      }),
    );
  });

  it('honors --log-level and --log-format overrides', async () => {
    const h = makeHarness();
    const promise = runServe({ stdio: true, logLevel: 'debug', logFormat: 'pretty' }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.stdioControls.finishDone();
    await promise;

    expect(h.createLogger).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'debug', format: 'pretty', destination: 'stderr' }),
    );
  });

  it('uses the stdio downstream when --stdio is passed explicitly', async () => {
    const h = makeHarness();
    const onStarted = vi.fn();
    h.deps.onStarted = onStarted;

    const promise = runServe({ stdio: true }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.stdioControls.finishDone();
    const code = await promise;

    expect(code).toBe(0);
    expect(h.createStdio).toHaveBeenCalledTimes(1);
    expect(h.createHttp).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ mode: 'stdio' }));
  });

  it('reports the bound URL on the default http path', async () => {
    const h = makeHarness();
    const onStarted = vi.fn();
    h.deps.onStarted = onStarted;

    const promise = runServe({ http: true }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.httpControls.finishDone();
    const code = await promise;

    expect(code).toBe(0);
    expect(h.createHttp).toHaveBeenCalledTimes(1);
    expect(h.createStdio).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'http',
        url: expect.any(URL) as unknown as URL,
      }),
    );
  });

  it('refuses --http when config.server.http.enabled is false', async () => {
    const config: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      server: {
        ...DEFAULT_CONFIG.server,
        http: { ...DEFAULT_CONFIG.server.http, enabled: false },
      },
    };
    const h = makeHarness(config);
    const code = await runServe({ http: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/http\.enabled is false/);
    expect(h.createHttp).not.toHaveBeenCalled();
  });

  it('returns 1 and writes to stderr when loadConfig rejects', async () => {
    const h = makeHarness();
    h.loadConfig.mockRejectedValueOnce(new Error('not json'));
    const code = await runServe({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/failed to load config/);
    expect(h.stderr.value).toMatch(/not json/);
    expect(h.createHttp).not.toHaveBeenCalled();
  });

  it('disposes the runtime if the downstream fails to start', async () => {
    const h = makeHarness();
    h.stdioControls.server.start = vi.fn(() => Promise.reject(new Error('bind failed')));

    const code = await runServe({ stdio: true }, h.deps);
    expect(code).toBe(1);
    expect(h.disposeSpy).toHaveBeenCalledTimes(1);
    expect(h.stderr.value).toMatch(/failed to start stdio server/);
    expect(h.stderr.value).toMatch(/bind failed/);
  });

  it('disposes the runtime after the downstream done resolves', async () => {
    const h = makeHarness();
    const promise = runServe({ stdio: true }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.disposeSpy).not.toHaveBeenCalled();
    h.stdioControls.finishDone();
    await promise;
    expect(h.disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('binds http with --force-http even when server.http.enabled is false', async () => {
    const config: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      server: {
        ...DEFAULT_CONFIG.server,
        http: { ...DEFAULT_CONFIG.server.http, enabled: false },
      },
    };
    const h = makeHarness(config);
    const promise = runServe({ http: true, forceHttp: true }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.httpControls.finishDone();
    const code = await promise;

    expect(code).toBe(0);
    expect(h.createHttp).toHaveBeenCalledTimes(1);
    expect(h.stderr.value).not.toMatch(/http\.enabled is false/);
  });

  it('does not touch the state file for a foreground serve (no managed env)', async () => {
    const h = makeHarness();
    const promise = runServe({ http: true }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.httpControls.finishDone();
    await promise;

    expect(h.writeStateSpy).not.toHaveBeenCalled();
    expect(h.clearStateSpy).not.toHaveBeenCalled();
  });

  it('publishes the state file after the listener binds when managed', async () => {
    const h = makeHarness();
    h.deps.processEnv = {
      TOOLBOX_SERVE_STATE_PATH: '/state/serve-state.json',
      TOOLBOX_SERVE_LOG_PATH: '/state/serve.log',
    };
    h.deps.isManagedChild = () => true;
    const onStarted = vi.fn();
    h.deps.onStarted = onStarted;

    const promise = runServe({ http: true, forceHttp: true }, h.deps);
    await Promise.resolve();
    await Promise.resolve();

    // State is published before onStarted fires and before done resolves.
    expect(h.writeStateSpy).toHaveBeenCalledTimes(1);
    expect(h.writeStateSpy).toHaveBeenCalledWith('/state/serve-state.json', {
      version: 1,
      pid: 4242,
      mode: 'http',
      url: 'http://127.0.0.1:7331/mcp',
      logPath: '/state/serve.log',
      startedAt: '2026-05-25T12:00:00.000Z',
    });
    expect(h.clearStateSpy).not.toHaveBeenCalled();

    h.httpControls.finishDone();
    await promise;
    expect(h.clearStateSpy).toHaveBeenCalledWith('/state/serve-state.json');
  });

  it('defaults the recorded log path to a sibling serve.log when unset', async () => {
    const h = makeHarness();
    h.deps.processEnv = { TOOLBOX_SERVE_STATE_PATH: '/state/serve-state.json' };
    h.deps.isManagedChild = () => true;

    const promise = runServe({ http: true, forceHttp: true }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.httpControls.finishDone();
    await promise;

    expect(h.writeStateSpy).toHaveBeenCalledWith(
      '/state/serve-state.json',
      expect.objectContaining({ logPath: '/state/serve.log' }),
    );
  });

  it('tears down the listener and returns 1 when publishing state fails', async () => {
    const h = makeHarness();
    h.deps.processEnv = { TOOLBOX_SERVE_STATE_PATH: '/state/serve-state.json' };
    h.deps.isManagedChild = () => true;
    h.writeStateSpy.mockRejectedValueOnce(new Error('ENOSPC'));

    const code = await runServe({ http: true, forceHttp: true }, h.deps);

    expect(code).toBe(1);
    expect(h.httpControls.stopSpy).toHaveBeenCalledTimes(1);
    expect(h.disposeSpy).toHaveBeenCalledTimes(1);
    expect(h.stderr.value).toMatch(/failed to publish daemon state/);
    expect(h.clearStateSpy).not.toHaveBeenCalled();
  });

  it('does not clear a successor daemon that bound the freed port', async () => {
    const h = makeHarness();
    h.deps.processEnv = { TOOLBOX_SERVE_STATE_PATH: '/state/serve-state.json' };
    h.deps.isManagedChild = () => true;
    // On shutdown the state now names a different pid — a successor took over.
    h.readStateSpy.mockResolvedValueOnce({
      version: 1,
      pid: 9999,
      mode: 'http',
      url: 'http://127.0.0.1:7331/mcp',
      logPath: '/state/serve.log',
      startedAt: '2026-05-25T12:30:00.000Z',
    });

    const promise = runServe({ http: true, forceHttp: true }, h.deps);
    await Promise.resolve();
    await Promise.resolve();
    h.httpControls.finishDone();
    await promise;

    expect(h.clearStateSpy).not.toHaveBeenCalled();
  });
});

describe('resolveForceHttp', () => {
  it('forces HTTP only when the marker is set AND the managed-child handshake holds', () => {
    expect(resolveForceHttp({ TOOLBOX_SERVE_FORCE_HTTP: '1' }, true)).toBe(true);
  });

  it('rejects the marker without the unforgeable handshake (forged ambient env)', () => {
    expect(resolveForceHttp({ TOOLBOX_SERVE_FORCE_HTTP: '1' }, false)).toBe(false);
  });

  it('returns false when the marker is absent even for a managed child', () => {
    expect(resolveForceHttp({}, true)).toBe(false);
    expect(resolveForceHttp({ TOOLBOX_SERVE_FORCE_HTTP: '0' }, true)).toBe(false);
  });
});

describe('hasManagedChildHandle', () => {
  it('reports true when the handshake fd is an inherited pipe', () => {
    const statFd = (): { isFIFO: () => boolean; isSocket: () => boolean } => ({
      isFIFO: () => true,
      isSocket: () => false,
    });
    expect(hasManagedChildHandle(statFd)).toBe(true);
  });

  it('reports true for an inherited socket', () => {
    const statFd = (): { isFIFO: () => boolean; isSocket: () => boolean } => ({
      isFIFO: () => false,
      isSocket: () => true,
    });
    expect(hasManagedChildHandle(statFd)).toBe(true);
  });

  it('reports false when the fd is a regular file or terminal', () => {
    const statFd = (): { isFIFO: () => boolean; isSocket: () => boolean } => ({
      isFIFO: () => false,
      isSocket: () => false,
    });
    expect(hasManagedChildHandle(statFd)).toBe(false);
  });

  it('reports false when the fd is not open (EBADF)', () => {
    const statFd = (): { isFIFO: () => boolean; isSocket: () => boolean } => {
      throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
    };
    expect(hasManagedChildHandle(statFd)).toBe(false);
  });
});
