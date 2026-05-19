import {
  createNoopLogger,
  type ServerConfig,
  type ServerStatus,
  type ToolBoxConfig,
} from '@toolbox/core';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import type {
  CallToolResult,
  ListToolsResult,
  UpstreamSession,
  UpstreamSessionEvent,
  UpstreamSessionEvents,
} from '../../upstream-client/index.js';
import { createGatewayRuntime } from '../runtime.js';

interface FakeSessionControls {
  session: UpstreamSession;
  emitStatus(status: ServerStatus): void;
  emitToolsListChanged(): void;
  setCachedTools(tools: Tool[]): void;
  startCalls: number;
  disposeCalls: number;
}

function makeFakeSession(serverName: string): FakeSessionControls {
  const handlers: { [K in UpstreamSessionEvent]: Set<UpstreamSessionEvents[K]> } = {
    status: new Set(),
    tools_list_changed: new Set(),
  };
  let cached: ListToolsResult | undefined;
  let status: ServerStatus = { kind: 'stopped' };
  const counts = { start: 0, dispose: 0 };

  const session: UpstreamSession = {
    serverName,
    get status() {
      return status;
    },
    start: vi.fn(() => {
      counts.start += 1;
      return Promise.resolve();
    }),
    restart: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => {
      counts.dispose += 1;
      return Promise.resolve();
    }),
    cachedTools: () => cached,
    listTools: vi.fn(() => Promise.resolve(cached ?? { tools: [] })),
    callTool: vi.fn(() => Promise.resolve({ content: [] }) as Promise<CallToolResult>),
    ping: vi.fn(() => Promise.resolve()),
    on(event, handler) {
      handlers[event].add(handler);
    },
    off(event, handler) {
      handlers[event].delete(handler);
    },
  };

  return {
    session,
    emitStatus: (next) => {
      status = next;
      for (const h of handlers.status) {
        h(next);
      }
    },
    emitToolsListChanged: () => {
      for (const h of handlers.tools_list_changed) {
        h();
      }
    },
    setCachedTools: (tools) => {
      cached = { tools };
    },
    get startCalls() {
      return counts.start;
    },
    get disposeCalls() {
      return counts.dispose;
    },
  };
}

function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  };
}

const STDIO_SERVER: ServerConfig = {
  type: 'stdio',
  enabled: true,
  command: 'fake',
  args: [],
};

const HTTP_SERVER: ServerConfig = {
  type: 'http',
  enabled: true,
  url: 'http://example.invalid/mcp',
};

function makeConfig(servers: Record<string, ServerConfig>): ToolBoxConfig {
  return {
    version: 1,
    server: {
      stdio: { enabled: true },
      http: { enabled: true, host: '127.0.0.1', port: 0, path: '/mcp' },
    },
    progressiveDisclosure: {
      enabled: false,
      mode: 'session',
      bootstrapTools: false,
      autoRevealExactServerMatches: false,
      maxSearchResults: 20,
    },
    namespacing: { separator: '__', format: 'server__tool', collisionStrategy: 'error' },
    auth: { storage: { type: 'keychain' } },
    servers,
    tools: {},
  };
}

describe('createGatewayRuntime', () => {
  it('creates a session for each enabled server and skips disabled ones', () => {
    const made: string[] = [];
    const runtime = createGatewayRuntime({
      config: makeConfig({
        jira: STDIO_SERVER,
        github: HTTP_SERVER,
        disabled: { ...STDIO_SERVER, enabled: false },
      }),
      logger: createNoopLogger(),
      createSession: (name) => {
        made.push(name);
        return makeFakeSession(name).session;
      },
    });

    expect(made.sort()).toEqual(['github', 'jira']);
    expect(runtime.upstreams.get('jira')).toBeDefined();
    expect(runtime.upstreams.get('github')).toBeDefined();
    expect(runtime.upstreams.get('disabled')).toBeUndefined();
  });

  it('startUpstreams() calls start() on every session synchronously', () => {
    const controls = new Map<string, FakeSessionControls>();
    const runtime = createGatewayRuntime({
      config: makeConfig({ jira: STDIO_SERVER, github: HTTP_SERVER }),
      logger: createNoopLogger(),
      createSession: (name) => {
        const c = makeFakeSession(name);
        controls.set(name, c);
        return c.session;
      },
    });

    runtime.startUpstreams();

    expect(controls.get('jira')?.startCalls).toBe(1);
    expect(controls.get('github')?.startCalls).toBe(1);
  });

  it('mirrors session status changes into the status registry', () => {
    const controls = new Map<string, FakeSessionControls>();
    const runtime = createGatewayRuntime({
      config: makeConfig({ jira: STDIO_SERVER }),
      logger: createNoopLogger(),
      createSession: (name) => {
        const c = makeFakeSession(name);
        controls.set(name, c);
        return c.session;
      },
    });

    expect(runtime.statusRegistry.get('jira')?.status).toEqual({ kind: 'stopped' });

    const jira = controls.get('jira');
    if (!jira) {
      throw new Error('jira session not created');
    }

    jira.emitStatus({ kind: 'starting', attempt: 1 });
    expect(runtime.statusRegistry.get('jira')?.status).toEqual({ kind: 'starting', attempt: 1 });

    jira.setCachedTools([tool('echo'), tool('search')]);
    const since = new Date('2026-05-01T00:00:00Z');
    jira.emitStatus({ kind: 'connected', since });

    const entry = runtime.statusRegistry.get('jira');
    expect(entry?.status).toEqual({ kind: 'connected', since });
    expect(entry?.toolCount).toBe(2);
    expect(entry?.lastConnectedAt).toEqual(since);
  });

  it('publishes connected upstream tools through the namespaced tool registry', () => {
    const controls = new Map<string, FakeSessionControls>();
    const runtime = createGatewayRuntime({
      config: makeConfig({ jira: STDIO_SERVER }),
      logger: createNoopLogger(),
      createSession: (name) => {
        const c = makeFakeSession(name);
        controls.set(name, c);
        return c.session;
      },
    });

    const jira = controls.get('jira');
    if (!jira) {
      throw new Error('jira session not created');
    }

    expect(runtime.toolRegistry.list()).toEqual([]);

    jira.setCachedTools([tool('search_issues'), tool('create_issue')]);
    jira.emitStatus({ kind: 'connected', since: new Date() });

    const exposed = runtime.toolRegistry.list().map((t) => t.exposedName);
    expect(exposed).toEqual(['jira__create_issue', 'jira__search_issues']);
  });

  it("drops a server's tools when its status leaves connected", () => {
    const controls = new Map<string, FakeSessionControls>();
    const runtime = createGatewayRuntime({
      config: makeConfig({ jira: STDIO_SERVER }),
      logger: createNoopLogger(),
      createSession: (name) => {
        const c = makeFakeSession(name);
        controls.set(name, c);
        return c.session;
      },
    });

    const jira = controls.get('jira');
    if (!jira) {
      throw new Error('jira session not created');
    }

    jira.setCachedTools([tool('echo')]);
    jira.emitStatus({ kind: 'connected', since: new Date() });
    expect(runtime.toolRegistry.list()).toHaveLength(1);

    jira.emitStatus({ kind: 'error', error: new Error('boom'), nextRetryAt: null });
    expect(runtime.toolRegistry.list()).toEqual([]);
    expect(runtime.statusRegistry.get('jira')?.toolCount).toBe(0);
  });

  it('refreshes the tool registry when tools_list_changed fires while connected', () => {
    const controls = new Map<string, FakeSessionControls>();
    const runtime = createGatewayRuntime({
      config: makeConfig({ jira: STDIO_SERVER }),
      logger: createNoopLogger(),
      createSession: (name) => {
        const c = makeFakeSession(name);
        controls.set(name, c);
        return c.session;
      },
    });

    const jira = controls.get('jira');
    if (!jira) {
      throw new Error('jira session not created');
    }

    jira.setCachedTools([tool('echo')]);
    jira.emitStatus({ kind: 'connected', since: new Date() });
    expect(runtime.toolRegistry.list().map((t) => t.exposedName)).toEqual(['jira__echo']);

    jira.setCachedTools([tool('echo'), tool('shout')]);
    jira.emitToolsListChanged();
    expect(runtime.toolRegistry.list().map((t) => t.exposedName)).toEqual([
      'jira__echo',
      'jira__shout',
    ]);
    expect(runtime.statusRegistry.get('jira')?.toolCount).toBe(2);
  });

  it('ignores tools_list_changed when the session is not connected', () => {
    const controls = new Map<string, FakeSessionControls>();
    const runtime = createGatewayRuntime({
      config: makeConfig({ jira: STDIO_SERVER }),
      logger: createNoopLogger(),
      createSession: (name) => {
        const c = makeFakeSession(name);
        controls.set(name, c);
        return c.session;
      },
    });

    const jira = controls.get('jira');
    if (!jira) {
      throw new Error('jira session not created');
    }

    jira.setCachedTools([tool('echo')]);
    jira.emitToolsListChanged();
    expect(runtime.toolRegistry.list()).toEqual([]);
  });

  it('dispose() awaits every session.dispose() in parallel', async () => {
    const controls = new Map<string, FakeSessionControls>();
    const runtime = createGatewayRuntime({
      config: makeConfig({ jira: STDIO_SERVER, github: HTTP_SERVER }),
      logger: createNoopLogger(),
      createSession: (name) => {
        const c = makeFakeSession(name);
        controls.set(name, c);
        return c.session;
      },
    });

    await runtime.dispose();

    expect(controls.get('jira')?.disposeCalls).toBe(1);
    expect(controls.get('github')?.disposeCalls).toBe(1);
  });

  it('detaches its session listeners on dispose so post-dispose events are ignored', async () => {
    const controls = new Map<string, FakeSessionControls>();
    const runtime = createGatewayRuntime({
      config: makeConfig({ jira: STDIO_SERVER }),
      logger: createNoopLogger(),
      createSession: (name) => {
        const c = makeFakeSession(name);
        controls.set(name, c);
        return c.session;
      },
    });

    const jira = controls.get('jira');
    if (!jira) {
      throw new Error('jira session not created');
    }
    jira.setCachedTools([tool('echo')]);
    jira.emitStatus({ kind: 'connected', since: new Date() });
    expect(runtime.toolRegistry.list()).toHaveLength(1);

    await runtime.dispose();
    // Snapshot the registries' post-dispose state so we can assert it
    // didn't move when stray events fire afterwards.
    const toolsAfterDispose = runtime.toolRegistry.list();
    const statusAfterDispose = runtime.statusRegistry.get('jira')?.status;

    // After dispose, a stray status event from a session reference held by
    // a consumer must not mutate the registries — listeners are detached
    // and the closure graph between session and registries is broken.
    jira.setCachedTools([tool('echo'), tool('shout')]);
    jira.emitStatus({ kind: 'starting', attempt: 1 });
    jira.emitToolsListChanged();

    expect(runtime.toolRegistry.list()).toEqual(toolsAfterDispose);
    expect(runtime.statusRegistry.get('jira')?.status).toEqual(statusAfterDispose);
  });
});
