import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createNoopLogger, type ToolBoxConfig } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createDownstreamHttpServer } from '../../downstream-server/http.js';
import type { DownstreamHttpServer } from '../../downstream-server/types.js';
import { createGatewayRuntime, type GatewayRuntime } from '../runtime.js';

const ECHO_FIXTURE = fileURLToPath(
  new URL('../../upstream-client/__tests__/__fixtures__/echo-server.mjs', import.meta.url),
);

const activeClients = new Set<Client>();
const activeServers = new Set<DownstreamHttpServer>();
const activeRuntimes = new Set<GatewayRuntime>();

afterEach(async () => {
  for (const client of activeClients) {
    await client.close().catch(() => undefined);
  }
  activeClients.clear();
  for (const server of activeServers) {
    await server.stop().catch(() => undefined);
  }
  activeServers.clear();
  for (const runtime of activeRuntimes) {
    await runtime.dispose().catch(() => undefined);
  }
  activeRuntimes.clear();
});

function makeConfig(overrides?: Partial<ToolBoxConfig['progressiveDisclosure']>): ToolBoxConfig {
  return {
    version: 1,
    server: {
      stdio: { enabled: true },
      http: { enabled: true, host: '127.0.0.1', port: 0, path: '/mcp' },
    },
    progressiveDisclosure: {
      enabled: false,
      mode: 'session',
      bootstrapTools: true,
      autoRevealExactServerMatches: false,
      maxSearchResults: 20,
      ...overrides,
    },
    namespacing: { separator: '__', format: 'server__tool', collisionStrategy: 'error' },
    servers: {
      echo: {
        type: 'stdio',
        enabled: true,
        command: process.execPath,
        args: [ECHO_FIXTURE],
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface NotificationCounter {
  client: Client;
  count: () => number;
}

function attachToolsListChangedCounter(client: Client): NotificationCounter {
  let received = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    received += 1;
    return Promise.resolve();
  });
  return { client, count: () => received };
}

async function connectClient(url: URL, name: string): Promise<NotificationCounter> {
  const client = new Client({ name, version: '0.0.0' }, { capabilities: {} });
  activeClients.add(client);
  const counter = attachToolsListChangedCounter(client);
  await client.connect(new StreamableHTTPClientTransport(url) as Transport);
  return counter;
}

function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  };
}

describe('M4-06 tools/list_changed notification wiring', () => {
  it('reveal_tools with multiple names produces a single notification on the calling session', async () => {
    const config = makeConfig();
    const logger = createNoopLogger();

    const runtime = createGatewayRuntime({ config, logger, processEnv: process.env });
    activeRuntimes.add(runtime);
    runtime.startUpstreams();
    await waitFor(() => runtime.statusRegistry.get('echo')?.status.kind === 'connected');

    const downstream = createDownstreamHttpServer({
      logger,
      http: { host: '127.0.0.1', port: 0, path: '/mcp' },
      registerHandlers: runtime.registerHandlers,
    });
    activeServers.add(downstream);
    await downstream.start();

    const counter = await connectClient(downstream.url, 'reveal-test');

    await counter.client.callTool({
      name: 'toolbox__reveal_tools',
      arguments: { tools: ['echo__echo', 'echo__slow'] },
    });

    // Allow the 50ms debounce window plus scheduling slack to elapse.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(counter.count()).toBe(1);
  }, 15_000);

  it('an upstream tool-set change notifies every active downstream session', async () => {
    const config = makeConfig();
    const logger = createNoopLogger();

    const runtime = createGatewayRuntime({ config, logger, processEnv: process.env });
    activeRuntimes.add(runtime);
    runtime.startUpstreams();
    await waitFor(() => runtime.statusRegistry.get('echo')?.status.kind === 'connected');

    const downstream = createDownstreamHttpServer({
      logger,
      http: { host: '127.0.0.1', port: 0, path: '/mcp' },
      registerHandlers: runtime.registerHandlers,
    });
    activeServers.add(downstream);
    await downstream.start();

    const counterA = await connectClient(downstream.url, 'upstream-test-a');
    const counterB = await connectClient(downstream.url, 'upstream-test-b');

    // Drive a fresh tool list through the registry — equivalent to the
    // upstream emitting tools_list_changed with a different tool set.
    runtime.toolRegistry.setServerEntry({
      serverName: 'echo',
      status: { kind: 'connected', since: new Date() },
      enabled: true,
      tools: [tool('echo'), tool('emit_log'), tool('slow'), tool('shout')],
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(counterA.count()).toBe(1);
    expect(counterB.count()).toBe(1);
  }, 15_000);

  it('notifyAllSessionsToolsChanged() broadcasts a notification to every active session', async () => {
    const config = makeConfig();
    const logger = createNoopLogger();

    const runtime = createGatewayRuntime({ config, logger, processEnv: process.env });
    activeRuntimes.add(runtime);
    runtime.startUpstreams();
    await waitFor(() => runtime.statusRegistry.get('echo')?.status.kind === 'connected');

    const downstream = createDownstreamHttpServer({
      logger,
      http: { host: '127.0.0.1', port: 0, path: '/mcp' },
      registerHandlers: runtime.registerHandlers,
    });
    activeServers.add(downstream);
    await downstream.start();

    const counterA = await connectClient(downstream.url, 'broadcast-test-a');
    const counterB = await connectClient(downstream.url, 'broadcast-test-b');

    runtime.notifyAllSessionsToolsChanged();

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(counterA.count()).toBe(1);
    expect(counterB.count()).toBe(1);
  }, 15_000);

  it('hide_tools that removes nothing emits no notification (no visibility change)', async () => {
    const config = makeConfig();
    const logger = createNoopLogger();

    const runtime = createGatewayRuntime({ config, logger, processEnv: process.env });
    activeRuntimes.add(runtime);
    runtime.startUpstreams();
    await waitFor(() => runtime.statusRegistry.get('echo')?.status.kind === 'connected');

    const downstream = createDownstreamHttpServer({
      logger,
      http: { host: '127.0.0.1', port: 0, path: '/mcp' },
      registerHandlers: runtime.registerHandlers,
    });
    activeServers.add(downstream);
    await downstream.start();

    const counter = await connectClient(downstream.url, 'hide-noop-test');

    await counter.client.callTool({
      name: 'toolbox__hide_tools',
      arguments: { tools: ['echo__echo'] },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(counter.count()).toBe(0);
  }, 15_000);
});
