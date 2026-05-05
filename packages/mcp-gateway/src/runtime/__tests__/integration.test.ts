import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createNoopLogger, type ToolBoxConfig } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import { BOOTSTRAP_TOOL_NAMES } from '../../bootstrap-tools/index.js';
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
      bootstrapTools: false,
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

describe('gateway runtime + downstream HTTP integration', () => {
  it('round-trips initialize → tools/list → tools/call against a stdio upstream', async () => {
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

    const client = new Client(
      { name: 'toolbox-serve-it-test', version: '0.0.0' },
      { capabilities: {} },
    );
    activeClients.add(client);
    await client.connect(new StreamableHTTPClientTransport(downstream.url) as Transport);

    expect(client.getServerVersion()).toMatchObject({ name: 'toolbox' });

    const list = await client.listTools();
    const exposed = list.tools.map((t) => t.name).sort();
    expect(exposed).toEqual(['echo__echo', 'echo__emit_log', 'echo__slow']);

    const result = await client.callTool({
      name: 'echo__echo',
      arguments: { message: 'roundtrip' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'roundtrip' }]);

    const status = runtime.statusRegistry.get('echo');
    expect(status?.status.kind).toBe('connected');
    expect(status?.toolCount).toBe(3);

    await client.close();
    activeClients.delete(client);

    await downstream.stop();
    activeServers.delete(downstream);

    await runtime.dispose();
    activeRuntimes.delete(runtime);

    expect(runtime.statusRegistry.get('echo')?.status.kind).toBe('stopped');
  }, 15_000);

  it('honours progressiveDisclosure.enabled across tools/list and tools/call, and reflects mid-session toggles', async () => {
    const config = makeConfig({ enabled: true, bootstrapTools: true });
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

    const client = new Client(
      { name: 'toolbox-disclosure-toggle-test', version: '0.0.0' },
      { capabilities: {} },
    );
    activeClients.add(client);
    await client.connect(new StreamableHTTPClientTransport(downstream.url) as Transport);

    // Disclosure on, no reveals — listing is bootstrap-only.
    {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual([...BOOTSTRAP_TOOL_NAMES].sort());
      expect(names).not.toContain('echo__echo');
    }

    // Calls to non-revealed tools are refused with a clear MCP error.
    await expect(
      client.callTool({ name: 'echo__echo', arguments: { message: 'no' } }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('toolbox__reveal_tools') as unknown,
    });

    // Reveal one tool — it now appears in the listing and is callable.
    await client.callTool({
      name: 'toolbox__reveal_tools',
      arguments: { tools: ['echo__echo'] },
    });
    {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain('echo__echo');
      expect(names).not.toContain('echo__slow');
    }
    {
      const result = await client.callTool({
        name: 'echo__echo',
        arguments: { message: 'revealed' },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'revealed' }]);
    }

    // Flip the live config to disclosure-off — every echo tool surfaces and
    // is callable on the next request.
    config.progressiveDisclosure.enabled = false;
    runtime.notifyAllSessionsToolsChanged();
    {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toContain('echo__echo');
      expect(names).toContain('echo__slow');
      expect(names).toContain('echo__emit_log');
      // Bootstrap tools still surface alongside the upstream catalogue.
      for (const bootstrapName of BOOTSTRAP_TOOL_NAMES) {
        expect(names).toContain(bootstrapName);
      }
    }
    {
      const result = await client.callTool({
        name: 'echo__slow',
        arguments: { delayMs: 0 },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'slept 0ms' }]);
    }

    // Flip back on — `echo__slow` was never revealed in this session and is
    // refused again.
    config.progressiveDisclosure.enabled = true;
    runtime.notifyAllSessionsToolsChanged();
    await expect(
      client.callTool({ name: 'echo__slow', arguments: { delayMs: 0 } }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });

    await client.close();
    activeClients.delete(client);

    await downstream.stop();
    activeServers.delete(downstream);

    await runtime.dispose();
    activeRuntimes.delete(runtime);
  }, 15_000);

  it('shuts down cleanly when the downstream HTTP server receives a SIGINT signal', async () => {
    const config = makeConfig();
    const logger = createNoopLogger();

    // Build a process-like EventEmitter so we can synthesise SIGINT without
    // raising it on the actual test runner. The downstream attaches its own
    // `signal` listener to this.
    const fakeProcess = new (
      await import('node:events')
    ).EventEmitter() as unknown as NodeJS.Process;

    const runtime = createGatewayRuntime({ config, logger, processEnv: process.env });
    activeRuntimes.add(runtime);
    runtime.startUpstreams();
    await waitFor(() => runtime.statusRegistry.get('echo')?.status.kind === 'connected');

    const downstream = createDownstreamHttpServer({
      logger,
      http: { host: '127.0.0.1', port: 0, path: '/mcp' },
      registerHandlers: runtime.registerHandlers,
      process: fakeProcess,
    });
    activeServers.add(downstream);
    await downstream.start();

    // Confirm the listener is up before signalling so the test exercises the
    // signal-driven shutdown path rather than a no-op early-exit.
    expect(downstream.url.port).not.toBe('0');

    // Simulate SIGINT — the downstream's own signal handler calls stop().
    fakeProcess.emit('SIGINT', 'SIGINT');

    await downstream.done;
    activeServers.delete(downstream);

    await runtime.dispose();
    activeRuntimes.delete(runtime);

    expect(runtime.statusRegistry.get('echo')?.status.kind).toBe('stopped');
  }, 15_000);
});
