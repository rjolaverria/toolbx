import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { createNoopLogger } from '@toolbox/core';
import type { NamespaceOptions, ServerStatus } from '@toolbox/core';
import { describe, expect, it, vi } from 'vitest';

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
): Promise<{ code: number; message: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error && typeof (err as unknown as { code?: unknown }).code === 'number') {
      return { code: (err as unknown as { code: number }).code, message: err.message };
    }
    throw new Error(`expected an MCP error, got: ${String(err)}`, { cause: err });
  }
  throw new Error('expected promise to reject');
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
}): Promise<{ client: Client; closeAll: () => Promise<void> }> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const built = buildToolboxMcpServer({
    logger: createNoopLogger(),
    sessionId: 'tools-call-test',
    registerHandlers: (server, session) => {
      registerToolsCallHandler(server, session, opts.registry, opts.upstreams);
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

    expect(jira.callTool).toHaveBeenCalledWith('search_issues', { jql: 'project = TLBX' });
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
});
