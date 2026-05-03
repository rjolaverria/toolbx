import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { createNoopLogger } from '@toolbox/core';
import type { Logger, NamespaceOptions, ServerStatus } from '@toolbox/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createBootstrapToolRegistry,
  type BootstrapToolRegistry,
} from '../../../bootstrap-tools/index.js';
import { createToolRegistry, type ToolRegistry } from '../../../registry/index.js';
import type { CallToolResult, UpstreamSession } from '../../../upstream-client/index.js';
import { buildToolboxMcpServer } from '../../server.js';
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
}): Promise<{ client: Client; closeAll: () => Promise<void> }> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const bootstrap = opts.bootstrap ?? createBootstrapToolRegistry();
  const built = buildToolboxMcpServer({
    logger: createNoopLogger(),
    sessionId: 'tools-call-test',
    registerHandlers: (server, session) => {
      registerToolsCallHandler(server, session, opts.registry, opts.upstreams, {
        namespacing: NS,
        ...(opts.resolveTimeoutMs !== undefined ? { resolveTimeoutMs: opts.resolveTimeoutMs } : {}),
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
        bootstrap,
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
