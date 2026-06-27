import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { createNoopLogger, createSessionVisibility } from '@toolbx/core';
import type { NamespaceOptions, ServerStatus, SessionVisibility } from '@toolbx/core';
import { describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_TOOL_NAMES,
  createBootstrapToolRegistry,
  type BootstrapToolRegistry,
} from '../../../bootstrap-tools/index.js';
import { createToolRegistry, type ToolRegistry } from '../../../registry/index.js';
import { buildToolbxMcpServer } from '../../server.js';
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
  bootstrap?: BootstrapToolRegistry;
  suppressInitialized?: boolean;
  visibility?: SessionVisibility;
  isDisclosureEnabled?: () => boolean;
  isToolEnabled?: (exposedName: string) => boolean;
  controlPlane?: boolean;
}): Promise<{ client: Client; closeAll: () => Promise<void> }> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const bootstrap = opts.bootstrap ?? createBootstrapToolRegistry();
  const built = buildToolbxMcpServer({
    logger: createNoopLogger(),
    sessionId: 'tools-list-test',
    ...(opts.controlPlane !== undefined ? { controlPlane: opts.controlPlane } : {}),
    registerHandlers: (server, session) => {
      registerToolsListHandler(server, session, opts.registry, bootstrap, {
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
    { name: 'toolbx-tools-list-test-client', version: '0.0.0' },
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

  it('does not filter upstream tools when visibility is provided but disclosure is off', async () => {
    // Mirrors the runtime, where the visibility seam is wired regardless of
    // the toggle. The flag gates the filtering, not the seam.
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues'), tool('create_issue')],
    });
    const visibility = createSessionVisibility({ mode: 'session' });
    // No reveals — but disclosure is off, so every upstream tool surfaces.

    const { client, closeAll } = await connect({
      registry,
      visibility,
      isDisclosureEnabled: () => false,
    });
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(['jira__create_issue', 'jira__search_issues']);
    await closeAll();
  });

  it('drops upstream tools whose `isToolEnabled` returns false (per-tool override)', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues'), tool('create_issue')],
    });

    const { client, closeAll } = await connect({
      registry,
      isToolEnabled: (name) => name !== 'jira__create_issue',
    });
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(['jira__search_issues']);
    await closeAll();
  });

  it('drops upstream tools whose exposed name is reserved by a bootstrap tool', async () => {
    // Simulates an upstream server literally named `toolbx` exposing a
    // tool that namespaces to `toolbx__search_tools`. The bootstrap entry
    // reserves that name; the upstream tool must not appear in the listing
    // because it isn't reachable through tools/call either.
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'toolbx',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_tools'), tool('something_else')],
    });
    const bootstrap = createBootstrapToolRegistry();
    bootstrap.add({
      descriptor: {
        name: 'toolbx__search_tools',
        description: 'reserved bootstrap',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      invoke() {
        return { content: [{ type: 'text', text: 'bootstrap' }] };
      },
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(['toolbx__search_tools', 'toolbx__something_else']);
    expect(result.tools[0]?.description).toBe('reserved bootstrap');
    await closeAll();
  });
});

function bootstrapWithFiveNames(): BootstrapToolRegistry {
  const bootstrap = createBootstrapToolRegistry();
  for (const name of BOOTSTRAP_TOOL_NAMES) {
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

describe('tools/list handler — progressive disclosure mode', () => {
  it('returns only bootstrap tools when disclosure is on and nothing has been revealed', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues'), tool('create_issue')],
    });
    registry.setServerEntry({
      serverName: 'github',
      status: CONNECTED,
      enabled: true,
      tools: [tool('create_pull_request')],
    });
    const bootstrap = bootstrapWithFiveNames();
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });

    const { client, closeAll } = await connect({
      registry,
      bootstrap,
      visibility,
      isDisclosureEnabled: () => true,
    });

    const result = await client.listTools();
    expect(result.tools.map((t) => t.name).sort()).toEqual([...BOOTSTRAP_TOOL_NAMES].sort());
    await closeAll();
  });

  it('returns every enabled upstream tool for a control-plane session even with disclosure on', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues'), tool('create_issue')],
    });
    registry.setServerEntry({
      serverName: 'github',
      status: CONNECTED,
      enabled: true,
      tools: [tool('create_pull_request')],
    });
    const bootstrap = bootstrapWithFiveNames();
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });

    const { client, closeAll } = await connect({
      registry,
      bootstrap,
      visibility,
      isDisclosureEnabled: () => true,
      controlPlane: true,
    });

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('jira__search_issues');
    expect(names).toContain('jira__create_issue');
    expect(names).toContain('github__create_pull_request');
    await closeAll();
  });

  it('returns bootstrap tools plus revealed upstream tools when disclosure is on', async () => {
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
    const bootstrap = bootstrapWithFiveNames();
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });
    visibility.reveal(['jira__search_issues']);

    const { client, closeAll } = await connect({
      registry,
      bootstrap,
      visibility,
      isDisclosureEnabled: () => true,
    });

    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('jira__search_issues');
    expect(names).not.toContain('jira__create_issue');
    expect(names).not.toContain('github__create_pull_request');
    for (const name of BOOTSTRAP_TOOL_NAMES) {
      expect(names).toContain(name);
    }
    expect(result.tools.find((t) => t.name === 'jira__search_issues')?.description).toBe(
      'Search issues',
    );
    await closeAll();
  });

  it('reflects toggling progressiveDisclosure.enabled on the next tools/list call', async () => {
    // Mutating a shared flag mirrors how M5-03 will flip the config in place.
    let enabled = true;
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues'), tool('create_issue')],
    });
    const bootstrap = bootstrapWithFiveNames();
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
    });

    const { client, closeAll } = await connect({
      registry,
      bootstrap,
      visibility,
      isDisclosureEnabled: () => enabled,
    });

    // Disclosure on with no reveals — bootstrap-only.
    {
      const result = await client.listTools();
      expect(result.tools.map((t) => t.name).sort()).toEqual([...BOOTSTRAP_TOOL_NAMES].sort());
    }

    // Flip the toggle off — every upstream tool should surface immediately.
    enabled = false;
    {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('jira__search_issues');
      expect(names).toContain('jira__create_issue');
      for (const bootstrapName of BOOTSTRAP_TOOL_NAMES) {
        expect(names).toContain(bootstrapName);
      }
    }

    // Flip back on — back to bootstrap-only.
    enabled = true;
    {
      const result = await client.listTools();
      expect(result.tools.map((t) => t.name).sort()).toEqual([...BOOTSTRAP_TOOL_NAMES].sort());
    }
    await closeAll();
  });
});
