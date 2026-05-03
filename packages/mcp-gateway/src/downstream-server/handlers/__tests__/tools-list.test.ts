import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { createNoopLogger } from '@toolbox/core';
import type { NamespaceOptions, ServerStatus } from '@toolbox/core';
import { describe, expect, it } from 'vitest';

import { createBootstrapToolRegistry } from '../../../bootstrap-tools/index.js';
import { createToolRegistry, type ToolRegistry } from '../../../registry/index.js';
import { buildToolboxMcpServer } from '../../server.js';
import { registerToolsListHandler } from '../tools-list.js';

const NS: NamespaceOptions = { separator: '__', format: 'server__tool' };
const CONNECTED: ServerStatus = { kind: 'connected', since: new Date('2026-01-01T00:00:00Z') };

function tool(name: string, description?: string): Tool {
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  };
}

async function connect(opts: {
  registry: ToolRegistry;
  suppressInitialized?: boolean;
}): Promise<{ client: Client; closeAll: () => Promise<void> }> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const bootstrap = createBootstrapToolRegistry();
  const built = buildToolboxMcpServer({
    logger: createNoopLogger(),
    sessionId: 'tools-list-test',
    registerHandlers: (server, session) => {
      registerToolsListHandler(server, session, opts.registry, bootstrap);
    },
  });
  if (opts.suppressInitialized) {
    built.server.oninitialized = () => {};
  }
  await built.server.connect(serverTransport);

  const client = new Client(
    { name: 'toolbox-tools-list-test-client', version: '0.0.0' },
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

describe('tools/list handler — non-disclosure mode', () => {
  it('returns the namespaced union of tools from two healthy upstream servers in deterministic order', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues', 'Search issues'), tool('create_issue')],
    });
    registry.setServerEntry({
      serverName: 'github',
      status: CONNECTED,
      enabled: true,
      tools: [tool('create_pull_request')],
    });

    const { client, closeAll } = await connect({ registry });
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toMatchInlineSnapshot(`
      [
        "github__create_pull_request",
        "jira__create_issue",
        "jira__search_issues",
      ]
    `);
    expect(result.tools.find((t) => t.name === 'jira__search_issues')?.description).toBe(
      'Search issues',
    );
    await closeAll();
  });

  it('omits tools from a server that is disabled', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    registry.setServerEntry({
      serverName: 'github',
      status: CONNECTED,
      enabled: false,
      tools: [tool('create_pull_request')],
    });

    const { client, closeAll } = await connect({ registry });
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(['jira__search_issues']);
    await closeAll();
  });

  it('omits tools from a server stuck in auth_required', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: { kind: 'auth_required', reason: 'oauth flow pending' },
      enabled: true,
      tools: [tool('search_issues')],
    });
    registry.setServerEntry({
      serverName: 'github',
      status: CONNECTED,
      enabled: true,
      tools: [tool('create_pull_request')],
    });

    const { client, closeAll } = await connect({ registry });
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(['github__create_pull_request']);
    await closeAll();
  });

  it('reflects registry mutations on the next tools/list call', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });

    const { client, closeAll } = await connect({ registry });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['jira__search_issues']);

    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: false,
      tools: [tool('search_issues')],
    });

    expect((await client.listTools()).tools).toEqual([]);
    await closeAll();
  });

  it('rejects tools/list with InvalidRequest before initialized', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });

    const { client, closeAll } = await connect({ registry, suppressInitialized: true });
    await expect(client.listTools()).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
    await closeAll();
  });
});
