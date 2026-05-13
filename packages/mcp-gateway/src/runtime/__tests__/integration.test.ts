import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createNoopLogger } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import { BOOTSTRAP_TOOL_NAMES } from '../../bootstrap-tools/index.js';
import { createDownstreamHttpServer } from '../../downstream-server/http.js';
import { createGatewayRuntime } from '../runtime.js';

import {
  connectHttpClient,
  createIntegrationHarness,
  makeIntegrationConfig,
  startHarness,
  waitFor,
} from './__fixtures__/integration-helpers.js';

const harness = createIntegrationHarness();

afterEach(async () => {
  await harness.cleanup();
});

describe('gateway runtime + downstream HTTP integration', () => {
  it('round-trips initialize → tools/list → tools/call against a stdio upstream', async () => {
    const { runtime, downstream } = await startHarness({
      config: makeIntegrationConfig(),
      harness,
    });

    const client = await connectHttpClient(downstream.url, 'toolbox-serve-it-test', harness);

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
    harness.clients.delete(client);

    await downstream.stop();
    harness.servers.delete(downstream);

    await runtime.dispose();
    harness.runtimes.delete(runtime);

    expect(runtime.statusRegistry.get('echo')?.status.kind).toBe('stopped');
  }, 15_000);

  it('honours progressiveDisclosure.enabled across tools/list and tools/call, and reflects mid-session toggles', async () => {
    const config = makeIntegrationConfig({
      progressiveDisclosure: { enabled: true, bootstrapTools: true },
    });
    const { runtime, downstream } = await startHarness({ config, harness });

    const client = await connectHttpClient(
      downstream.url,
      'toolbox-disclosure-toggle-test',
      harness,
    );

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
  }, 15_000);

  it('shuts down cleanly when the downstream HTTP server receives a SIGINT signal', async () => {
    const config = makeIntegrationConfig();
    const logger = createNoopLogger();

    // Build a process-like EventEmitter so we can synthesise SIGINT without
    // raising it on the actual test runner. The downstream attaches its own
    // `signal` listener to this.
    const fakeProcess = new (
      await import('node:events')
    ).EventEmitter() as unknown as NodeJS.Process;

    const runtime = createGatewayRuntime({ config, logger, processEnv: process.env });
    harness.runtimes.add(runtime);
    runtime.startUpstreams();
    await waitFor(() => runtime.statusRegistry.get('echo')?.status.kind === 'connected');

    const downstream = createDownstreamHttpServer({
      logger,
      http: { host: '127.0.0.1', port: 0, path: '/mcp' },
      registerHandlers: runtime.registerHandlers,
      process: fakeProcess,
    });
    harness.servers.add(downstream);
    await downstream.start();

    expect(downstream.url.port).not.toBe('0');

    fakeProcess.emit('SIGINT', 'SIGINT');

    await downstream.done;
    harness.servers.delete(downstream);

    await runtime.dispose();
    harness.runtimes.delete(runtime);

    expect(runtime.statusRegistry.get('echo')?.status.kind).toBe('stopped');
  }, 15_000);
});
