import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  createNoopLogger,
  createSessionVisibility,
  readAuthExpiredMeta,
} from '@rjolaverria/toolbox-core';
import type {
  Logger,
  NamespaceOptions,
  ServerStatus,
  SessionVisibility,
} from '@rjolaverria/toolbox-core';
import { describe, expect, it, vi } from 'vitest';

import {
  BOOTSTRAP_TOOL_NAMES,
  createBootstrapToolRegistry,
  type BootstrapToolRegistry,
} from '../../../bootstrap-tools/index.js';
import { createToolRegistry, type ToolRegistry } from '../../../registry/index.js';
import type { CallToolResult, UpstreamSession } from '../../../upstream-client/index.js';
import { buildToolBoxMcpServer } from '../../server.js';
import { registerToolsCallHandler, type UpstreamSessionLookup } from '../tools-call.js';

const NS: NamespaceOptions = { separator: '__', format: 'server__tool' };
const CONNECTED: ServerStatus = { kind: 'connected', since: new Date('2026-01-01T00:00:00Z') };

function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  };
}

interface FakeUpstream {
  session: UpstreamSession;
  callTool: ReturnType<typeof vi.fn>;
}

function fakeUpstream(opts: {
  serverName: string;
  status?: ServerStatus;
  result?: CallToolResult;
}): FakeUpstream {
  const result: CallToolResult = opts.result ?? { content: [{ type: 'text', text: 'ok' }] };
  const callTool = vi.fn(() => Promise.resolve(result));
  const session = {
    serverName: opts.serverName,
    status: opts.status ?? CONNECTED,
    start: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
    cachedTools: vi.fn(),
    listTools: vi.fn(),
    callTool,
    ping: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as UpstreamSession;
  return { session, callTool };
}

async function rejectsAsMcpError(
  promise: Promise<unknown>,
): Promise<{ code: number; message: string; data?: unknown }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error && typeof (err as unknown as { code?: unknown }).code === 'number') {
      const e = err as unknown as { code: number; data?: unknown };
      return { code: e.code, message: err.message, data: e.data };
    }
    throw new Error(`expected an MCP error, got: ${String(err)}`, { cause: err });
  }
  throw new Error('expected promise to reject');
}

interface FakeLogger {
  logger: Logger;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}

function fakeLogger(): FakeLogger {
  const info = vi.fn();
  const warn = vi.fn();
  const logger = {
    info,
    warn,
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  } as unknown as Logger;
  return { logger, info, warn };
}

function lookupFrom(map: Record<string, UpstreamSession>): UpstreamSessionLookup {
  return {
    get(name) {
      return map[name];
    },
  };
}

async function connect(opts: {
  registry: ToolRegistry;
  upstreams: UpstreamSessionLookup;
  suppressInitialized?: boolean;
  resolveTimeoutMs?: (serverName: string) => number | undefined;
  logger?: Logger;
  bootstrap?: BootstrapToolRegistry;
  visibility?: SessionVisibility;
  isDisclosureEnabled?: () => boolean;
  isToolEnabled?: (exposedName: string) => boolean;
  controlPlane?: boolean;
}): Promise<{ client: Client; closeAll: () => Promise<void> }> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const bootstrap = opts.bootstrap ?? createBootstrapToolRegistry();
  const built = buildToolBoxMcpServer({
    logger: createNoopLogger(),
    sessionId: 'tools-call-test',
    ...(opts.controlPlane !== undefined ? { controlPlane: opts.controlPlane } : {}),
    registerHandlers: (server, session) => {
      registerToolsCallHandler(server, session, opts.registry, opts.upstreams, {
        namespacing: NS,
        ...(opts.resolveTimeoutMs !== undefined ? { resolveTimeoutMs: opts.resolveTimeoutMs } : {}),
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
        bootstrap,
        ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
        ...(opts.isDisclosureEnabled !== undefined
          ? { isDisclosureEnabled: opts.isDisclosureEnabled }
          : {}),
        ...(opts.isToolEnabled !== undefined ? { isToolEnabled: opts.isToolEnabled } : {}),
      });
    },
  });
  if (opts.suppressInitialized) {
    built.server.oninitialized = () => {};
  }
  await built.server.connect(serverTransport);

  const client = new Client(
    { name: 'toolbox-tools-call-test-client', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    client,
    closeAll: async () => {
      await client.close();
      await built.server.close();
    },
  };
}

describe('tools/call handler', () => {
  it('routes a namespaced call to the upstream server using the upstream tool name', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({
      serverName: 'jira',
      result: { content: [{ type: 'text', text: 'found-2' }] },
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
    });

    const result = await client.callTool({
      name: 'jira__search_issues',
      arguments: { jql: 'project = TLBX' },
    });

    expect(jira.callTool).toHaveBeenCalledTimes(1);
    expect(jira.callTool.mock.calls[0]?.[0]).toBe('search_issues');
    expect(jira.callTool.mock.calls[0]?.[1]).toEqual({ jql: 'project = TLBX' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'found-2' }] });
    await closeAll();
  });

  it('forwards the upstream result object byte-for-byte', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const upstreamResult: CallToolResult = {
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
      isError: false,
      structuredContent: { hits: 2, page: 1 },
    };
    const jira = fakeUpstream({ serverName: 'jira', result: upstreamResult });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
    });

    const result = await client.callTool({ name: 'jira__search_issues' });
    expect(result).toMatchObject(upstreamResult);
    await closeAll();
  });

  it('forwards an upstream tool error (`isError: true`) without rewriting it', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({
      serverName: 'jira',
      result: { content: [{ type: 'text', text: 'JQL parse error' }], isError: true },
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
    });

    const result = await client.callTool({
      name: 'jira__search_issues',
      arguments: { jql: '???' },
    });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'JQL parse error' }],
      isError: true,
    });
    await closeAll();
  });

  it('returns a structured re-auth message (not a JSON-RPC error) when the session reports auth_expired', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({ serverName: 'jira' });
    const authExpired = Object.assign(new Error('token expired'), {
      name: 'UpstreamAuthExpiredError',
    });
    jira.callTool.mockRejectedValue(authExpired);

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
    });

    const result = await client.callTool({ name: 'jira__search_issues' });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain('Authentication for "jira" has expired.');
    expect(content[0]?.text).toContain('tlbx auth login jira');
    expect(readAuthExpiredMeta(result._meta)).toEqual({ server: 'jira' });
    await closeAll();
  });

  it('rejects an unknown tool name with MethodNotFound', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({}),
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__nope' }));
    expect(err.code).toBe(ErrorCode.MethodNotFound);
    expect(err.message).toContain('jira__nope');
    await closeAll();
  });

  it('refuses a call to a disabled tool with MethodNotFound (no upstream dispatch)', async () => {
    // M5-02 — `tlbx tools disable` removes a tool from `tools/list`, but a
    // client that cached the exposed name from a prior session must also be
    // refused at call time. The error mirrors a truly unknown tool so the
    // disabled tool is indistinguishable from "does not exist."
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({ serverName: 'jira' });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
      isToolEnabled: (name) => name !== 'jira__search_issues',
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    expect(err.code).toBe(ErrorCode.MethodNotFound);
    expect(jira.callTool).not.toHaveBeenCalled();
    await closeAll();
  });

  it('refuses a disabled tool even when it is revealed under disclosure', async () => {
    // P2-05 §5.6(7): the disable gate takes precedence over the reveal gate, so
    // a tool the session has revealed is still uncallable while disabled — it
    // must not slip through as `not_revealed` or reach the upstream.
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({ serverName: 'jira' });
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });
    visibility.reveal(['jira__search_issues']);

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
      visibility,
      isDisclosureEnabled: () => true,
      isToolEnabled: (name) => name !== 'jira__search_issues',
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    expect(err.code).toBe(ErrorCode.MethodNotFound);
    expect(jira.callTool).not.toHaveBeenCalled();
    await closeAll();
  });

  it('rejects when the upstream session is not registered with InternalError naming the server', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({}),
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain('"jira"');
    await closeAll();
  });

  it('rejects when the upstream session is present but not connected', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({
      serverName: 'jira',
      status: { kind: 'error', error: new Error('boom'), nextRetryAt: new Date() },
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain('"jira"');
    expect(jira.callTool).not.toHaveBeenCalled();
    await closeAll();
  });

  it('attaches structured data to a server_unavailable error', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const errorStatus: ServerStatus = {
      kind: 'error',
      error: new Error('boom'),
      nextRetryAt: new Date('2026-01-01T00:00:00Z'),
    };
    const jira = fakeUpstream({ serverName: 'jira', status: errorStatus });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.data).toMatchObject({
      server: 'jira',
      status: { kind: 'error' },
    });
    await closeAll();
  });

  it('aborts the upstream call and reports a timeout when timeoutMs elapses', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });

    let observedSignal: AbortSignal | undefined;
    const callTool = vi.fn(
      (
        _name: string,
        _args: Record<string, unknown> | undefined,
        opts?: { signal?: AbortSignal },
      ) => {
        observedSignal = opts?.signal;
        return new Promise<CallToolResult>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      },
    );
    const session = {
      serverName: 'jira',
      status: CONNECTED,
      callTool,
    } as unknown as UpstreamSession;

    const startedAt = Date.now();
    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: session }),
      resolveTimeoutMs: () => 50,
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    const elapsedMs = Date.now() - startedAt;

    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.data).toMatchObject({
      server: 'jira',
      tool: 'search_issues',
      code: 'timeout',
      timeoutMs: 50,
    });
    expect(observedSignal?.aborted).toBe(true);
    // Allow generous slack for CI; we only need to confirm the call didn't hang.
    expect(elapsedMs).toBeLessThan(2000);
    await closeAll();
  });

  it('forwards McpError details from the upstream session as upstreamCode/upstreamData', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });

    const upstreamErr = new McpError(ErrorCode.InvalidParams, 'bad jql', { field: 'jql' });
    const callTool = vi.fn(() => Promise.reject(upstreamErr));
    const session = {
      serverName: 'jira',
      status: CONNECTED,
      callTool,
    } as unknown as UpstreamSession;

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: session }),
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.data).toMatchObject({
      server: 'jira',
      tool: 'search_issues',
      code: 'upstream',
      upstreamCode: ErrorCode.InvalidParams,
      upstreamData: { field: 'jql' },
    });
    await closeAll();
  });

  it('logs success at info with server, tool, durationMs, and outcome', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({ serverName: 'jira' });
    const log = fakeLogger();

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
      logger: log.logger,
    });

    await client.callTool({ name: 'jira__search_issues' });

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    const [fields] = log.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      server: 'jira',
      tool: 'jira__search_issues',
      outcome: 'ok',
    });
    expect(typeof fields.durationMs).toBe('number');
    await closeAll();
  });

  it('logs failures at warn with the route variant in the outcome field', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const callTool = vi.fn(() => Promise.reject(new Error('upstream blew up')));
    const session = {
      serverName: 'jira',
      status: CONNECTED,
      callTool,
    } as unknown as UpstreamSession;
    const log = fakeLogger();

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: session }),
      logger: log.logger,
    });

    await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields] = log.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      server: 'jira',
      tool: 'jira__search_issues',
      outcome: 'upstream_error:upstream',
    });
    await closeAll();
  });

  it('does not invoke callTool when the upstream session is disabled', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({ serverName: 'jira', status: { kind: 'disabled' } });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.data).toMatchObject({ server: 'jira', status: { kind: 'disabled' } });
    expect(jira.callTool).not.toHaveBeenCalled();
    await closeAll();
  });

  it('rejects tools/call with InvalidRequest before initialized', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({ serverName: 'jira' });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
      suppressInitialized: true,
    });

    await expect(client.callTool({ name: 'jira__search_issues' })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
    await closeAll();
  });

  it('dispatches bootstrap-tool calls without consulting upstream sessions', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({ serverName: 'jira' });

    const lookupCalls: string[] = [];
    const upstreams: UpstreamSessionLookup = {
      get(name) {
        lookupCalls.push(name);
        return name === 'jira' ? jira.session : undefined;
      },
    };

    const bootstrap = createBootstrapToolRegistry();
    const invokeCalls: unknown[] = [];
    bootstrap.add({
      descriptor: {
        name: 'toolbox__ping',
        description: 'test',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      invoke(args) {
        invokeCalls.push(args);
        return Promise.resolve({ content: [{ type: 'text', text: 'bootstrap-pong' }] });
      },
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams,
      bootstrap,
    });

    const result = await client.callTool({
      name: 'toolbox__ping',
      arguments: { msg: 'hi' },
    });

    expect(invokeCalls).toEqual([{ msg: 'hi' }]);
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'bootstrap-pong' }] });
    expect(lookupCalls).toEqual([]);
    expect(jira.callTool).not.toHaveBeenCalled();
    await closeAll();
  });

  it('translates a thrown bootstrap-tool error into isError without crashing the handler', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    const bootstrap = createBootstrapToolRegistry();
    bootstrap.add({
      descriptor: {
        name: 'toolbox__boom',
        description: 'always throws',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      invoke() {
        throw new Error('kaboom');
      },
    });
    const log = fakeLogger();

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({}),
      bootstrap,
      logger: log.logger,
    });

    const result = await client.callTool({ name: 'toolbox__boom' });
    expect(result.isError).toBe(true);
    const block = (result.content as { type: string; text: string }[])[0];
    expect(block?.type).toBe('text');
    expect(block?.text).toContain('kaboom');
    expect(log.warn).toHaveBeenCalled();
    const [fields] = log.warn.mock.calls.at(-1) as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      server: 'toolbox',
      tool: 'toolbox__boom',
      outcome: 'bootstrap_error',
    });
    await closeAll();
  });

  it('warns when a bootstrap-tool dispatch shadows an upstream tool with the same exposed name', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'toolbox',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_tools')],
    });
    const upstream = fakeUpstream({ serverName: 'toolbox' });
    const bootstrap = createBootstrapToolRegistry();
    bootstrap.add({
      descriptor: {
        name: 'toolbox__search_tools',
        description: 'reserved',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      invoke() {
        return { content: [{ type: 'text', text: 'reserved' }] };
      },
    });
    const log = fakeLogger();

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ toolbox: upstream.session }),
      bootstrap,
      logger: log.logger,
    });

    const result = await client.callTool({ name: 'toolbox__search_tools' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'reserved' }] });
    expect(upstream.callTool).not.toHaveBeenCalled();

    const shadowingWarn = log.warn.mock.calls.find(
      ([fields]) =>
        typeof (fields as Record<string, unknown>).tool === 'string' &&
        (fields as Record<string, unknown>).tool === 'toolbox__search_tools' &&
        (fields as Record<string, unknown>).server === undefined,
    );
    expect(shadowingWarn).toBeDefined();
    await closeAll();
  });
});

function bootstrapWithRevealAndSearch(): BootstrapToolRegistry {
  const bootstrap = createBootstrapToolRegistry();
  for (const name of ['toolbox__reveal_tools', 'toolbox__search_tools']) {
    bootstrap.add({
      descriptor: {
        name,
        description: `bootstrap ${name}`,
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      invoke() {
        return { content: [{ type: 'text', text: name }] };
      },
    });
  }
  return bootstrap;
}

describe('tools/call handler — progressive disclosure mode', () => {
  it('calls an unrevealed upstream tool for a control-plane session even with disclosure on', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({
      serverName: 'jira',
      result: { content: [{ type: 'text', text: 'hits' }] },
    });
    const bootstrap = bootstrapWithRevealAndSearch();
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
      bootstrap,
      visibility,
      isDisclosureEnabled: () => true,
      controlPlane: true,
    });

    const result = await client.callTool({ name: 'jira__search_issues' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'hits' }] });
    expect(jira.callTool).toHaveBeenCalledOnce();
    await closeAll();
  });

  it('refuses calls to non-revealed upstream tools with InvalidRequest pointing at reveal_tools', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({ serverName: 'jira' });
    const bootstrap = bootstrapWithRevealAndSearch();
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
      bootstrap,
      visibility,
      isDisclosureEnabled: () => true,
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain('jira__search_issues');
    expect(err.message).toContain('toolbox__reveal_tools');
    expect(err.message).toContain('toolbox__search_tools');
    expect(err.data).toMatchObject({ tool: 'jira__search_issues', code: 'not_revealed' });
    expect(jira.callTool).not.toHaveBeenCalled();
    await closeAll();
  });

  it('allows calls to revealed upstream tools when disclosure is on', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({
      serverName: 'jira',
      result: { content: [{ type: 'text', text: 'hits' }] },
    });
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });
    visibility.reveal(['jira__search_issues']);

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
      visibility,
      isDisclosureEnabled: () => true,
    });

    const result = await client.callTool({ name: 'jira__search_issues' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'hits' }] });
    expect(jira.callTool).toHaveBeenCalledTimes(1);
    await closeAll();
  });

  it('always allows bootstrap-tool calls regardless of reveal state', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    const bootstrap = createBootstrapToolRegistry();
    bootstrap.add({
      descriptor: {
        name: 'toolbox__search_tools',
        description: 'bootstrap',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      invoke() {
        return { content: [{ type: 'text', text: 'searched' }] };
      },
    });
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({}),
      bootstrap,
      visibility,
      isDisclosureEnabled: () => true,
    });

    const result = await client.callTool({ name: 'toolbox__search_tools' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'searched' }] });
    await closeAll();
  });

  it('does not refuse non-revealed calls when disclosure is off', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({ serverName: 'jira' });
    const visibility = createSessionVisibility({ mode: 'session' });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
      visibility,
      isDisclosureEnabled: () => false,
    });

    await expect(client.callTool({ name: 'jira__search_issues' })).resolves.toBeDefined();
    expect(jira.callTool).toHaveBeenCalledTimes(1);
    await closeAll();
  });

  it('omits bootstrap-tool references from the not_revealed message when bootstrap tools are disabled', async () => {
    // The config schema permits `progressiveDisclosure.enabled=true` while
    // `bootstrapTools=false` (e.g. CLI-driven reveal flow). The error message
    // must not point clients at toolbox__reveal_tools / toolbox__search_tools
    // when those methods aren't actually registered.
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({ serverName: 'jira' });
    // Note: empty bootstrap registry mirrors the runtime when bootstrapTools=false.
    const visibility = createSessionVisibility({ mode: 'session' });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
      visibility,
      isDisclosureEnabled: () => true,
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain('jira__search_issues');
    expect(err.message).not.toContain('toolbox__reveal_tools');
    expect(err.message).not.toContain('toolbox__search_tools');
    expect(err.data).toMatchObject({ tool: 'jira__search_issues', code: 'not_revealed' });
    await closeAll();
  });

  it('rejects unknown tool names with MethodNotFound even when disclosure is on', async () => {
    // Truly unknown names (typos, removed tools) must keep their existing
    // contract — the router returns `MethodNotFound`, not `not_revealed`.
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({}),
      visibility,
      isDisclosureEnabled: () => true,
    });

    const err = await rejectsAsMcpError(client.callTool({ name: 'jira__nope' }));
    expect(err.code).toBe(ErrorCode.MethodNotFound);
    expect(err.message).toContain('jira__nope');
    await closeAll();
  });

  it('reflects toggling progressiveDisclosure.enabled on the next tools/call', async () => {
    let enabled = true;
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const jira = fakeUpstream({
      serverName: 'jira',
      result: { content: [{ type: 'text', text: 'hits' }] },
    });
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });

    const { client, closeAll } = await connect({
      registry,
      upstreams: lookupFrom({ jira: jira.session }),
      visibility,
      isDisclosureEnabled: () => enabled,
    });

    // Disclosure on, no reveals — refused.
    const refused = await rejectsAsMcpError(client.callTool({ name: 'jira__search_issues' }));
    expect(refused.code).toBe(ErrorCode.InvalidRequest);
    expect(jira.callTool).not.toHaveBeenCalled();

    // Flip off — same call now succeeds.
    enabled = false;
    const result = await client.callTool({ name: 'jira__search_issues' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'hits' }] });
    expect(jira.callTool).toHaveBeenCalledTimes(1);
    await closeAll();
  });
});
