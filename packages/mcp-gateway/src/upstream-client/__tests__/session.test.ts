import {
  createNoopLogger,
  type ServerStatus,
  type StdioServerConfig,
} from '@rjolaverria/toolbox-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UpstreamAuthExpiredError,
  UpstreamAuthRequiredError,
  UpstreamNotConnectedError,
} from '../errors.js';
import { createUpstreamSession, type UpstreamClientFactory } from '../session.js';
import type {
  CallToolResult,
  ListToolsResult,
  UpstreamClient,
  UpstreamClientEvent,
  UpstreamClientEvents,
  UpstreamExitInfo,
} from '../types.js';

interface FakeClientControls {
  client: UpstreamClient;
  resolveConnect: (err?: Error) => void;
  emitToolsListChanged: () => void;
  emitExit: (info: UpstreamExitInfo) => void;
  setListToolsResult: (result: ListToolsResult) => void;
  failListTools: (err: Error) => void;
  setPingResult: (resultFactory: () => Promise<void>) => void;
  setCallToolResult: (resultFactory: () => Promise<CallToolResult>) => void;
  deferDisconnect: () => void;
  flushDisconnect: () => void;
  connectCalls: number;
  disconnectCalls: number;
  pingCalls: number;
  listToolsCalls: number;
}

function makeFakeClient(serverName?: string): FakeClientControls {
  const handlers: { [K in UpstreamClientEvent]: Set<UpstreamClientEvents[K]> } = {
    tools_list_changed: new Set(),
    log: new Set(),
    exit: new Set(),
  };
  let pendingConnect: { resolve: () => void; reject: (err: Error) => void } | null = null;
  let listToolsResult = { tools: [] } as unknown as ListToolsResult;
  let listToolsError: Error | null = null;
  let pingFactory: () => Promise<void> = () => Promise.resolve();
  let callToolFactory: () => Promise<CallToolResult> = () =>
    Promise.resolve({ content: [] } as unknown as CallToolResult);
  let blockDisconnect = false;
  const disconnectResolvers: Array<() => void> = [];
  const counters = { connect: 0, disconnect: 0, ping: 0, listTools: 0 };

  const client: UpstreamClient = {
    serverName,
    connect() {
      counters.connect += 1;
      return new Promise<void>((resolve, reject) => {
        pendingConnect = { resolve, reject };
      });
    },
    disconnect() {
      counters.disconnect += 1;
      if (blockDisconnect) {
        return new Promise<void>((resolve) => {
          disconnectResolvers.push(resolve);
        });
      }
      return Promise.resolve();
    },
    listTools() {
      counters.listTools += 1;
      if (listToolsError) {
        return Promise.reject(listToolsError);
      }
      return Promise.resolve(listToolsResult);
    },
    callTool(): Promise<CallToolResult> {
      return callToolFactory();
    },
    ping() {
      counters.ping += 1;
      return pingFactory();
    },
    on(event, handler) {
      handlers[event].add(handler);
    },
    off(event, handler) {
      handlers[event].delete(handler);
    },
  };

  return {
    client,
    resolveConnect: (err) => {
      const p = pendingConnect;
      pendingConnect = null;
      if (!p) {
        throw new Error('connect() not awaiting');
      }
      if (err) {
        p.reject(err);
      } else {
        p.resolve();
      }
    },
    emitToolsListChanged: () => {
      for (const handler of handlers.tools_list_changed) {
        handler();
      }
    },
    emitExit: (info) => {
      for (const handler of handlers.exit) {
        handler(info);
      }
    },
    setListToolsResult: (result) => {
      listToolsResult = result;
      listToolsError = null;
    },
    failListTools: (err) => {
      listToolsError = err;
    },
    setPingResult: (factory) => {
      pingFactory = factory;
    },
    setCallToolResult: (factory) => {
      callToolFactory = factory;
    },
    deferDisconnect: () => {
      blockDisconnect = true;
    },
    flushDisconnect: () => {
      blockDisconnect = false;
      const pending = disconnectResolvers.splice(0);
      for (const resolve of pending) {
        resolve();
      }
    },
    get connectCalls() {
      return counters.connect;
    },
    get disconnectCalls() {
      return counters.disconnect;
    },
    get pingCalls() {
      return counters.ping;
    },
    get listToolsCalls() {
      return counters.listTools;
    },
  };
}

const stdioConfig: StdioServerConfig = {
  type: 'stdio',
  enabled: true,
  command: 'fake',
  args: [],
};

interface SessionFixture {
  controls: FakeClientControls[];
  factory: UpstreamClientFactory;
}

function fixture(): SessionFixture {
  const controls: FakeClientControls[] = [];
  const factory: UpstreamClientFactory = () => {
    const next = makeFakeClient();
    controls.push(next);
    return next.client;
  };
  return { controls, factory };
}

function statusKinds(events: ServerStatus[]): string[] {
  return events.map((e) => e.kind);
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createUpstreamSession — happy path', () => {
  it('initializes, caches tools, and reports connected', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });
    const events: ServerStatus[] = [];
    session.on('status', (s) => events.push(s));

    const tools = { tools: [{ name: 'echo' }] } as unknown as ListToolsResult;
    const startPromise = session.start();
    expect(controls).toHaveLength(1);
    controls[0]!.setListToolsResult(tools);
    controls[0]!.resolveConnect();
    await startPromise;

    expect(statusKinds(events)).toEqual(['starting', 'connected']);
    expect((events[0] as { attempt: number }).attempt).toBe(1);
    expect(session.cachedTools()).toBe(tools);
    expect(session.status.kind).toBe('connected');
    await session.dispose();
  });

  it('refreshes the tool cache when the upstream emits tools_list_changed', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });
    const initialTools = { tools: [{ name: 'a' }] } as unknown as ListToolsResult;

    const startPromise = session.start();
    controls[0]!.setListToolsResult(initialTools);
    controls[0]!.resolveConnect();
    await startPromise;
    expect(session.cachedTools()).toBe(initialTools);

    const updated = { tools: [{ name: 'a' }, { name: 'b' }] } as unknown as ListToolsResult;
    controls[0]!.setListToolsResult(updated);

    let toolsListChanged = 0;
    session.on('tools_list_changed', () => {
      toolsListChanged += 1;
    });
    controls[0]!.emitToolsListChanged();
    // refreshTools resolves on a microtask
    await flushMicrotasks();
    expect(session.cachedTools()).toBe(updated);
    expect(toolsListChanged).toBe(1);
    await session.dispose();
  });
});

describe('createUpstreamSession — reconnect', () => {
  it('reconnects after an unexpected exit using exponential backoff', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      backoff: { initialMs: 100, factor: 2, maxMs: 10_000 },
    });
    const events: ServerStatus[] = [];
    session.on('status', (s) => events.push(s));

    const startPromise = session.start();
    controls[0]!.resolveConnect();
    await startPromise;
    expect(session.status.kind).toBe('connected');

    // First crash → first retry should happen after 100ms.
    controls[0]!.emitExit({ intentional: false });
    expect(session.status.kind).toBe('error');
    expect((session.status as { nextRetryAt: Date }).nextRetryAt.getTime()).toBe(Date.now() + 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(controls).toHaveLength(2);
    controls[1]!.resolveConnect();
    await flushMicrotasks();
    expect(session.status.kind).toBe('connected');

    // Crash a second time before reconnect — backoff should still start at 100ms
    // because each successful connection resets the failure counter.
    controls[1]!.emitExit({ intentional: false });
    expect((session.status as { nextRetryAt: Date }).nextRetryAt.getTime()).toBe(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(controls).toHaveLength(3);
    controls[2]!.resolveConnect();
    await flushMicrotasks();
    expect(session.status.kind).toBe('connected');

    expect(statusKinds(events)).toEqual([
      'starting',
      'connected',
      'error',
      'starting',
      'connected',
      'error',
      'starting',
      'connected',
    ]);
    await session.dispose();
  });

  it('uses growing backoff across consecutive connect failures and caps at maxMs', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      backoff: { initialMs: 100, factor: 2, maxMs: 250 },
    });

    // Attempt 1 fails synchronously after we resolveConnect with an error.
    const startPromise = session.start();
    controls[0]!.resolveConnect(new Error('boom'));
    await startPromise;
    expect(session.status.kind).toBe('error');
    expect((session.status as { nextRetryAt: Date }).nextRetryAt.getTime()).toBe(Date.now() + 100);

    // After 100ms attempt 2 starts and also fails.
    await vi.advanceTimersByTimeAsync(100);
    expect(controls).toHaveLength(2);
    controls[1]!.resolveConnect(new Error('boom'));
    await flushMicrotasks();
    expect((session.status as { nextRetryAt: Date }).nextRetryAt.getTime()).toBe(Date.now() + 200);

    // After 200ms attempt 3 starts and fails. Delay should now be capped to 250.
    await vi.advanceTimersByTimeAsync(200);
    expect(controls).toHaveLength(3);
    controls[2]!.resolveConnect(new Error('boom'));
    await flushMicrotasks();
    expect((session.status as { nextRetryAt: Date }).nextRetryAt.getTime()).toBe(Date.now() + 250);

    await session.dispose();
  });
});

describe('createUpstreamSession — auth_required', () => {
  it('stops reconnecting when the upstream reports auth_required', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect(
      UpstreamAuthRequiredError.forMissingBearerToken('TOKEN', undefined),
    );
    await startPromise;

    expect(session.status.kind).toBe('auth_required');
    // Advance the clock past any reasonable backoff window.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controls).toHaveLength(1);

    // restart() re-enters the loop.
    const restartPromise = session.restart();
    await flushMicrotasks();
    expect(controls).toHaveLength(2);
    controls[1]!.resolveConnect();
    await restartPromise;
    expect(session.status.kind).toBe('connected');
    await session.dispose();
  });

  it('carries the bearer tokenEnv into the auth_required status', async () => {
    // The status is the daemon-authoritative signal `tlbx run` reads to tell a
    // missing-bearer-env case (restart the daemon) from a missing-OAuth-token
    // case (`tlbx auth login`).
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect(
      UpstreamAuthRequiredError.forMissingBearerToken('GITHUB_TOKEN', 'github'),
    );
    await startPromise;

    expect(session.status).toMatchObject({ kind: 'auth_required', tokenEnv: 'GITHUB_TOKEN' });
    await session.dispose();
  });

  it('omits tokenEnv from the auth_required status for a missing OAuth token', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect(UpstreamAuthRequiredError.forMissingOAuthToken('github'));
    await startPromise;

    expect(session.status.kind).toBe('auth_required');
    expect((session.status as { tokenEnv?: string }).tokenEnv).toBeUndefined();
    await session.dispose();
  });
});

describe('createUpstreamSession — auth_required (oauth)', () => {
  it('stops reconnecting when connect() rejects with the missing-oauth-token error', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect(UpstreamAuthRequiredError.forMissingOAuthToken(undefined));
    await startPromise;

    expect(session.status.kind).toBe('auth_required');
    // Advance past any reasonable backoff window — no retry should fire.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controls).toHaveLength(1);
    await session.dispose();
  });
});

describe('createUpstreamSession — auth_expired (oauth lazy refresh)', () => {
  it('reports auth_expired when connect rejects with UpstreamAuthExpiredError', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect(new UpstreamAuthExpiredError('fake', 'token expired'));
    await startPromise;

    expect(session.status.kind).toBe('auth_expired');
    if (session.status.kind === 'auth_expired') {
      expect(session.status.reason).toBe('token expired');
    }
    await session.dispose();
  });

  it('schedules a reconnect when connect-time auth_expired never cached tools', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      backoff: { initialMs: 100, factor: 2, maxMs: 10_000 },
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect(new UpstreamAuthExpiredError('fake', 'token expired'));
    await startPromise;
    expect(session.status.kind).toBe('auth_expired');

    // No tool list was ever cached, so no downstream tools/call can reach the
    // session to drive call-based recovery (SPECS §4.6.2). The connection
    // manager's reconnect backoff carries the session back once the user has
    // re-authenticated — no restart, no downstream call.
    await vi.advanceTimersByTimeAsync(100);
    expect(controls).toHaveLength(2);
    const tools = { tools: [{ name: 'echo' }] } as unknown as ListToolsResult;
    controls[1]!.setListToolsResult(tools);
    controls[1]!.resolveConnect();
    await flushMicrotasks();

    expect(session.status.kind).toBe('connected');
    expect(session.cachedTools()).toBe(tools);
    await session.dispose();
  });

  it('does not spin a background reconnect when mid-session auth_expired has cached tools', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      backoff: { initialMs: 100, factor: 2, maxMs: 10_000 },
    });

    const startPromise = session.start();
    const tools = { tools: [{ name: 'echo' }] } as unknown as ListToolsResult;
    controls[0]!.setListToolsResult(tools);
    controls[0]!.resolveConnect();
    await startPromise;
    expect(session.status.kind).toBe('connected');

    controls[0]!.setCallToolResult(() =>
      Promise.reject(new UpstreamAuthExpiredError('fake', 'mid-session expiry')),
    );
    await expect(session.callTool('echo', undefined)).rejects.toBeInstanceOf(
      UpstreamAuthExpiredError,
    );
    expect(session.status.kind).toBe('auth_expired');

    // Tools stay cached, so recovery is call-driven; no background reconnect
    // loop should fire on its own.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controls).toHaveLength(1);
    await session.dispose();
  });

  it('transitions connected -> auth_expired when a tool call throws UpstreamAuthExpiredError', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect();
    await startPromise;
    expect(session.status.kind).toBe('connected');

    controls[0]!.setCallToolResult(() =>
      Promise.reject(new UpstreamAuthExpiredError('fake', 'mid-session expiry')),
    );
    await expect(session.callTool('echo', undefined)).rejects.toBeInstanceOf(
      UpstreamAuthExpiredError,
    );
    expect(session.status.kind).toBe('auth_expired');
    await session.dispose();
  });

  it('recovers to connected when a tool call after auth_expired reconnects successfully', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect(new UpstreamAuthExpiredError('fake', 'token expired'));
    await startPromise;
    expect(session.status.kind).toBe('auth_expired');

    // The next tool call attempts a fresh connect (re-reading tokens). The
    // freshly-built client connects, simulating a successful `tlbx auth login`.
    const callPromise = session.callTool('echo', undefined);
    await flushMicrotasks();
    expect(controls).toHaveLength(2);
    controls[1]!.setCallToolResult(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'recovered' }],
      } as unknown as CallToolResult),
    );
    controls[1]!.resolveConnect();

    const result = await callPromise;
    expect(result.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(session.status.kind).toBe('connected');
    await session.dispose();
  });

  it('returns the auth_expired error when the reconnect after auth_expired still fails', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect(new UpstreamAuthExpiredError('fake', 'token expired'));
    await startPromise;
    expect(session.status.kind).toBe('auth_expired');

    const callPromise = session.callTool('echo', undefined);
    await flushMicrotasks();
    expect(controls).toHaveLength(2);
    controls[1]!.resolveConnect(new UpstreamAuthExpiredError('fake', 'still expired'));

    await expect(callPromise).rejects.toBeInstanceOf(UpstreamAuthExpiredError);
    expect(session.status.kind).toBe('auth_expired');
    await session.dispose();
  });

  it('stays in auth_expired (not terminal auth_required) when a recovery reconnect finds no stored token', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect(new UpstreamAuthExpiredError('fake', 'token expired'));
    await startPromise;
    expect(session.status.kind).toBe('auth_expired');

    // The user hasn't re-authenticated yet, so the recovery reconnect finds no
    // stored token (classified as auth_required). The session must NOT collapse
    // into terminal auth_required — that would strand the no-restart recovery
    // flow (SPECS §4.6.2). It stays auth_expired and rethrows re-auth guidance.
    const firstCall = session.callTool('echo', undefined);
    await flushMicrotasks();
    expect(controls).toHaveLength(2);
    controls[1]!.resolveConnect(UpstreamAuthRequiredError.forMissingOAuthToken(undefined));
    await expect(firstCall).rejects.toBeInstanceOf(UpstreamAuthExpiredError);
    expect(session.status.kind).toBe('auth_expired');

    // After the user finally runs `tlbx auth login`, the next call still drives
    // a fresh reconnect (the session is not stuck) and recovers.
    const secondCall = session.callTool('echo', undefined);
    await flushMicrotasks();
    expect(controls).toHaveLength(3);
    controls[2]!.setCallToolResult(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'recovered' }],
      } as unknown as CallToolResult),
    );
    controls[2]!.resolveConnect();
    const result = await secondCall;
    expect(result.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(session.status.kind).toBe('connected');
    await session.dispose();
  });

  it('does not let a stale auth_expired connect attempt clobber a concurrent restart', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      backoff: { initialMs: 100, factor: 2, maxMs: 10_000 },
    });

    // First connect attempt is still pending when a restart starts a second.
    const startPromise = session.start();
    const restartPromise = session.restart();
    await flushMicrotasks();
    expect(controls).toHaveLength(2);

    // The original attempt now rejects with expired creds — but it is stale, so
    // it must not resurrect auth_expired or schedule a reconnect over the new
    // attempt.
    controls[0]!.resolveConnect(new UpstreamAuthExpiredError('fake', 'stale attempt'));
    await flushMicrotasks();

    controls[1]!.resolveConnect();
    await Promise.all([startPromise, restartPromise]);

    expect(session.status.kind).toBe('connected');
    // No third client and no scheduled reconnect from the stale attempt.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controls).toHaveLength(2);
    await session.dispose();
  });

  it('does not let a stale auth_required connect attempt clobber a concurrent restart', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    const restartPromise = session.restart();
    await flushMicrotasks();
    expect(controls).toHaveLength(2);

    controls[0]!.resolveConnect(UpstreamAuthRequiredError.forMissingOAuthToken(undefined));
    await flushMicrotasks();

    controls[1]!.resolveConnect();
    await Promise.all([startPromise, restartPromise]);

    expect(session.status.kind).toBe('connected');
    expect(controls).toHaveLength(2);
    await session.dispose();
  });

  it('reports auth_expired when tools/list rejects with expired creds after a successful connect', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      backoff: { initialMs: 100, factor: 2, maxMs: 10_000 },
    });

    const startPromise = session.start();
    // initialize succeeds, but the first tools/list fails its OAuth refresh.
    controls[0]!.failListTools(new UpstreamAuthExpiredError('fake', 'tools/list expired'));
    controls[0]!.resolveConnect();
    await startPromise;

    expect(session.status.kind).toBe('auth_expired');
    expect(session.cachedTools()).toBeUndefined();
    await session.dispose();
  });

  it('reports auth_required when tools/list rejects with missing creds after a successful connect', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.failListTools(UpstreamAuthRequiredError.forMissingOAuthToken(undefined));
    controls[0]!.resolveConnect();
    await startPromise;

    expect(session.status.kind).toBe('auth_required');
    await session.dispose();
  });

  it('transitions to auth_expired when a tools_list_changed refresh fails with expired creds', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    const tools = { tools: [{ name: 'echo' }] } as unknown as ListToolsResult;
    controls[0]!.setListToolsResult(tools);
    controls[0]!.resolveConnect();
    await startPromise;
    expect(session.status.kind).toBe('connected');

    // A change notification triggers a refresh, but the token has since expired.
    controls[0]!.failListTools(new UpstreamAuthExpiredError('fake', 'refresh expired'));
    controls[0]!.emitToolsListChanged();
    await flushMicrotasks();

    expect(session.status.kind).toBe('auth_expired');
    await session.dispose();
  });

  it('surfaces a tools_list_changed missing-token failure as auth_expired, not auth_required', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });
    const events: ServerStatus[] = [];
    session.on('status', (s) => events.push(s));

    const startPromise = session.start();
    const tools = { tools: [{ name: 'echo' }] } as unknown as ListToolsResult;
    controls[0]!.setListToolsResult(tools);
    controls[0]!.resolveConnect();
    await startPromise;

    // A refresh after a change notification finds the token gone entirely.
    controls[0]!.failListTools(UpstreamAuthRequiredError.forMissingOAuthToken(undefined));
    controls[0]!.emitToolsListChanged();
    await flushMicrotasks();

    // connected -> auth_required is not a valid status transition; mid-session
    // credential loss is surfaced as auth_expired (which keeps tools published).
    expect(session.status.kind).toBe('auth_expired');
    expect(statusKinds(events)).not.toContain('auth_required');
    await session.dispose();
  });

  it('does not announce auth_expired when dispose races a tools/list auth failure', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });
    const events: ServerStatus[] = [];
    session.on('status', (s) => events.push(s));

    const startPromise = session.start();
    // connect succeeds, but the initial tools/list reports expired creds, and
    // the disconnect in that auth branch is held so dispose() can interleave.
    controls[0]!.failListTools(new UpstreamAuthExpiredError('fake', 'tools/list expired'));
    controls[0]!.deferDisconnect();
    controls[0]!.resolveConnect();
    await flushMicrotasks();

    const disposePromise = session.dispose();
    controls[0]!.flushDisconnect();
    await Promise.all([startPromise, disposePromise]);

    expect(session.status.kind).toBe('stopped');
    expect(statusKinds(events)).not.toContain('auth_expired');
  });

  it('surfaces a mid-call missing-token failure as auth_expired, not a stale connected', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });
    const events: ServerStatus[] = [];
    session.on('status', (s) => events.push(s));

    const startPromise = session.start();
    const tools = { tools: [{ name: 'echo' }] } as unknown as ListToolsResult;
    controls[0]!.setListToolsResult(tools);
    controls[0]!.resolveConnect();
    await startPromise;
    expect(session.status.kind).toBe('connected');

    // The token record is gone, so the upstream classifies the call failure as
    // auth_required rather than auth_expired.
    controls[0]!.setCallToolResult(() =>
      Promise.reject(UpstreamAuthRequiredError.forMissingOAuthToken(undefined)),
    );
    // The session enters auth_expired, so the thrown error is an
    // UpstreamAuthExpiredError — routeToolCall only renders that as the
    // structured re-auth result; rethrowing the raw auth_required would collapse
    // to a generic upstream_error.
    await expect(session.callTool('echo', undefined)).rejects.toBeInstanceOf(
      UpstreamAuthExpiredError,
    );

    // The session must not stay stale-connected. Mid-session credential loss is
    // surfaced as auth_expired (connected -> auth_required is an invalid
    // transition), keeping tools published for call-driven recovery.
    expect(session.status.kind).toBe('auth_expired');
    expect(statusKinds(events)).not.toContain('auth_required');
    await session.dispose();
  });

  it('routes a concurrent call to recovery, not the torn-down client, during a mid-call auth transition', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    const tools = { tools: [{ name: 'echo' }] } as unknown as ListToolsResult;
    controls[0]!.setListToolsResult(tools);
    controls[0]!.resolveConnect();
    await startPromise;

    controls[0]!.setCallToolResult(() =>
      Promise.reject(new UpstreamAuthExpiredError('fake', 'mid-session expiry')),
    );
    // Hold the disconnect: if the transition awaited it (instead of firing it
    // and moving to auth_expired synchronously), the session would stay
    // `connected` here and a concurrent call would reuse the dying client.
    controls[0]!.deferDisconnect();

    const callA = session.callTool('echo', undefined);
    await flushMicrotasks();

    // The mid-call transition completes synchronously, so the session is already
    // auth_expired: a concurrent call drives a fresh recovery connect rather
    // than reusing controls[0].
    const callB = session.callTool('echo', undefined);
    await flushMicrotasks();
    expect(controls).toHaveLength(2);

    controls[0]!.flushDisconnect();
    controls[1]!.setCallToolResult(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'recovered' }],
      } as unknown as CallToolResult),
    );
    controls[1]!.resolveConnect();

    await expect(callA).rejects.toBeInstanceOf(UpstreamAuthExpiredError);
    const resultB = await callB;
    expect(resultB.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(session.status.kind).toBe('connected');
    await session.dispose();
  });

  it('does not let a stale successful connect attempt clobber a concurrent restart', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    const restartPromise = session.restart();
    await flushMicrotasks();
    expect(controls).toHaveLength(2);

    // The original attempt connects late — after restart already created
    // controls[1]. It must not attach over the newer attempt.
    controls[0]!.resolveConnect();
    await flushMicrotasks();

    controls[1]!.setCallToolResult(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'new-attempt' }],
      } as unknown as CallToolResult),
    );
    controls[1]!.resolveConnect();
    await Promise.all([startPromise, restartPromise]);

    expect(session.status.kind).toBe('connected');
    // The live client must be the newer attempt, and the stale one torn down.
    expect(controls[0]!.disconnectCalls).toBeGreaterThan(0);
    const result = await session.callTool('echo', undefined);
    expect(result.content).toEqual([{ type: 'text', text: 'new-attempt' }]);
    await session.dispose();
  });
});

describe('createUpstreamSession — restart race', () => {
  it('rejects callTool issued while a restart is tearing down the active client', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect();
    await startPromise;
    expect(session.status.kind).toBe('connected');

    // Kick off a restart — teardown() must transition phase away from
    // `connected` synchronously so a concurrent call cannot reach the
    // disconnecting client.
    const restartPromise = session.restart();
    await expect(session.callTool('echo', undefined)).rejects.toBeInstanceOf(
      UpstreamNotConnectedError,
    );

    await flushMicrotasks();
    controls[1]!.resolveConnect();
    await restartPromise;
    expect(session.status.kind).toBe('connected');
    await session.dispose();
  });

  it('returns the same in-flight promise for concurrent start() callers', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
    });

    const first = session.start();
    const second = session.start();
    expect(first).toBe(second);
    expect(controls).toHaveLength(1);

    controls[0]!.resolveConnect();
    await first;
    expect(session.status.kind).toBe('connected');
    await session.dispose();
  });
});

describe('createUpstreamSession — dispose', () => {
  it('is idempotent and tears down timers and listeners', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      pingIntervalMs: 1_000,
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect();
    await startPromise;

    await session.dispose();
    expect(session.status.kind).toBe('stopped');
    expect(controls[0]!.disconnectCalls).toBe(1);

    // Second dispose is a no-op.
    await session.dispose();
    expect(controls[0]!.disconnectCalls).toBe(1);

    // No more pings after dispose.
    const pingsAfter = controls[0]!.pingCalls;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controls[0]!.pingCalls).toBe(pingsAfter);

    await expect(session.callTool('x', undefined)).rejects.toBeInstanceOf(
      UpstreamNotConnectedError,
    );
  });

  it('cancels a pending reconnect timer', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      backoff: { initialMs: 1_000, factor: 2, maxMs: 10_000 },
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect(new Error('boom'));
    await startPromise;
    expect(session.status.kind).toBe('error');

    await session.dispose();
    expect(session.status.kind).toBe('stopped');

    // If the timer were still alive, this would trigger a second connect.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controls).toHaveLength(1);
  });
});

describe('createUpstreamSession — ping', () => {
  it('treats a failing ping as a transport loss and reconnects', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      pingIntervalMs: 500,
      backoff: { initialMs: 50, factor: 2, maxMs: 1_000 },
    });

    const startPromise = session.start();
    controls[0]!.resolveConnect();
    await startPromise;

    controls[0]!.setPingResult(() => Promise.reject(new Error('pong missing')));

    await vi.advanceTimersByTimeAsync(500);
    // ping() rejection is awaited on a microtask
    await flushMicrotasks();
    expect(session.status.kind).toBe('error');

    await vi.advanceTimersByTimeAsync(50);
    expect(controls).toHaveLength(2);
    controls[1]!.resolveConnect();
    await flushMicrotasks();
    expect(session.status.kind).toBe('connected');
    await session.dispose();
  });

  it('transitions to auth_expired (preserving tools) when a background ping fails with expired creds', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      pingIntervalMs: 500,
      backoff: { initialMs: 50, factor: 2, maxMs: 1_000 },
    });

    const startPromise = session.start();
    const tools = { tools: [{ name: 'echo' }] } as unknown as ListToolsResult;
    controls[0]!.setListToolsResult(tools);
    controls[0]!.resolveConnect();
    await startPromise;
    expect(session.cachedTools()).toBe(tools);

    // An idle token ages out; the next keepalive ping hits the OAuth refresh
    // path and fails. This is mid-session expiry, not transport loss, so the
    // session must surface auth_expired (and keep tools published for the
    // call-driven recovery surface) rather than the generic error/retry path.
    controls[0]!.setPingResult(() =>
      Promise.reject(new UpstreamAuthExpiredError('fake', 'idle token expired')),
    );

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(session.status.kind).toBe('auth_expired');
    expect(session.cachedTools()).toBe(tools);
    // No generic reconnect backoff should be scheduled.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controls).toHaveLength(1);
    await session.dispose();
  });

  it('transitions to auth_expired (preserving tools) when a background ping fails with missing creds', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      pingIntervalMs: 500,
      backoff: { initialMs: 50, factor: 2, maxMs: 1_000 },
    });

    const startPromise = session.start();
    const tools = { tools: [{ name: 'echo' }] } as unknown as ListToolsResult;
    controls[0]!.setListToolsResult(tools);
    controls[0]!.resolveConnect();
    await startPromise;
    expect(session.cachedTools()).toBe(tools);

    // The token record was removed mid-session, so the keepalive ping classifies
    // as auth_required. Mid-session credential loss must land on auth_expired
    // (tools preserved for call-driven recovery), not the generic
    // transport-loss/error path that drops tools.
    controls[0]!.setPingResult(() =>
      Promise.reject(UpstreamAuthRequiredError.forMissingOAuthToken(undefined)),
    );

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(session.status.kind).toBe('auth_expired');
    expect(session.cachedTools()).toBe(tools);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controls).toHaveLength(1);
    await session.dispose();
  });

  it('schedules a reconnect when a ping fails with expired creds and no tools were cached', async () => {
    const { controls, factory } = fixture();
    const session = createUpstreamSession(stdioConfig, {
      logger: createNoopLogger(),
      createClient: factory,
      pingIntervalMs: 500,
      backoff: { initialMs: 100, factor: 2, maxMs: 10_000 },
    });

    const startPromise = session.start();
    // listTools fails during connect, so the connected session caches no tools.
    controls[0]!.failListTools(new Error('list failed'));
    controls[0]!.resolveConnect();
    await startPromise;
    expect(session.status.kind).toBe('connected');
    expect(session.cachedTools()).toBeUndefined();

    controls[0]!.setPingResult(() =>
      Promise.reject(new UpstreamAuthExpiredError('fake', 'idle token expired')),
    );
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(session.status.kind).toBe('auth_expired');

    // With no cached tools, no downstream call can drive recovery, so the
    // session must fall back to the reconnect backoff (as connect-time does).
    await vi.advanceTimersByTimeAsync(100);
    expect(controls).toHaveLength(2);
    controls[1]!.resolveConnect();
    await flushMicrotasks();
    expect(session.status.kind).toBe('connected');
    await session.dispose();
  });
});
