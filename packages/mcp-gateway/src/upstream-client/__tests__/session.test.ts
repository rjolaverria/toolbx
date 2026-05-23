import { createNoopLogger, type ServerStatus, type StdioServerConfig } from '@toolbox/core';
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
  setPingResult: (resultFactory: () => Promise<void>) => void;
  setCallToolResult: (resultFactory: () => Promise<CallToolResult>) => void;
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
  let pingFactory: () => Promise<void> = () => Promise.resolve();
  let callToolFactory: () => Promise<CallToolResult> = () =>
    Promise.resolve({ content: [] } as unknown as CallToolResult);
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
      return Promise.resolve();
    },
    listTools() {
      counters.listTools += 1;
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
    },
    setPingResult: (factory) => {
      pingFactory = factory;
    },
    setCallToolResult: (factory) => {
      callToolFactory = factory;
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
  it('transitions to auth_expired when connect rejects with UpstreamAuthExpiredError and does not retry', async () => {
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
    // No backoff retry loop — recovery is driven by the next tool call.
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
});
