import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createNoopLogger } from '@toolbx/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createDownstreamStdioServer } from '../../downstream-server/stdio.js';
import type { DownstreamStdioServer } from '../../downstream-server/types.js';
import { createGatewayRuntime, type GatewayRuntime } from '../runtime.js';

import {
  ECHO_FIXTURE,
  makeIntegrationConfig,
  waitFor,
} from './__fixtures__/integration-helpers.js';

// The HTTP-downstream integration tests in `integration.test.ts` already
// cover the proxy + bootstrap paths end-to-end. This file pairs the same
// gateway runtime with the stdio downstream surface so the stdio wire path
// (the `StdioServerTransport` reading newline-delimited JSON-RPC out of
// arbitrary streams) is exercised by a real MCP `Client`. We use two
// crossed PassThrough pipes so the protocol traffic flows over the same
// transport class a spawned `tlbx serve --stdio` subprocess would talk to,
// without requiring a built dist on disk.

interface StdioPair {
  clientToServer: PassThrough;
  serverToClient: PassThrough;
}

function makePipes(): StdioPair {
  return {
    clientToServer: new PassThrough(),
    serverToClient: new PassThrough(),
  };
}

const activeClients = new Set<Client>();
const activeDownstreams = new Set<DownstreamStdioServer>();
const activeRuntimes = new Set<GatewayRuntime>();

afterEach(async () => {
  for (const client of activeClients) {
    await client.close().catch(() => undefined);
  }
  activeClients.clear();
  for (const downstream of activeDownstreams) {
    await downstream.stop().catch(() => undefined);
  }
  activeDownstreams.clear();
  for (const runtime of activeRuntimes) {
    await runtime.dispose().catch(() => undefined);
  }
  activeRuntimes.clear();
});

describe('gateway runtime + downstream stdio integration', () => {
  it('round-trips initialize → tools/list → tools/call → tools/list_changed over real stdio transports', async () => {
    const config = makeIntegrationConfig({
      servers: {
        echo: {
          type: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [ECHO_FIXTURE],
        },
      },
    });
    const logger = createNoopLogger();

    const runtime = createGatewayRuntime({ config, logger, processEnv: process.env });
    activeRuntimes.add(runtime);
    runtime.startUpstreams();
    await waitFor(() => runtime.statusRegistry.get('echo')?.status.kind === 'connected');

    const pipes = makePipes();
    // Use a private EventEmitter as the signal target so the downstream does
    // not attach SIGINT/SIGTERM listeners to the actual test runner process.
    const fakeProcess = new EventEmitter() as unknown as NodeJS.Process;
    const downstream = createDownstreamStdioServer({
      logger,
      registerHandlers: runtime.registerHandlers,
      stdin: pipes.clientToServer,
      stdout: pipes.serverToClient,
      process: fakeProcess,
    });
    activeDownstreams.add(downstream);
    await downstream.start();

    // `StdioServerTransport` is a stream-based Transport — using it on both
    // ends with the streams crossed gives the client identical wire-level
    // behaviour to `StdioClientTransport` (newline-delimited JSON-RPC) but
    // skips the subprocess spawn. The CLI integration suite covers the
    // spawn path; this test covers the protocol path through
    // `createDownstreamStdioServer` directly.
    const clientTransport = new StdioServerTransport(pipes.serverToClient, pipes.clientToServer);
    const client = new Client({ name: 'toolbx-stdio-it', version: '0.0.0' }, { capabilities: {} });
    activeClients.add(client);

    let toolsListChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      toolsListChanged += 1;
      return Promise.resolve();
    });

    await client.connect(clientTransport);

    expect(client.getServerVersion()).toMatchObject({ name: 'toolbx' });
    expect(client.getServerCapabilities()?.tools).toMatchObject({ listChanged: true });

    const list = await client.listTools();
    const exposed = list.tools.map((t) => t.name).sort();
    expect(exposed).toEqual(['echo__echo', 'echo__emit_log', 'echo__slow']);

    const result = await client.callTool({
      name: 'echo__echo',
      arguments: { message: 'stdio-roundtrip' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'stdio-roundtrip' }]);

    // Drive a notifyAll() and confirm the stdio session receives it. This
    // exercises the same fan-out plumbing the HTTP downstream covers.
    runtime.notifyAllSessionsToolsChanged();
    await waitFor(() => toolsListChanged >= 1);
    expect(toolsListChanged).toBeGreaterThanOrEqual(1);

    await client.close();
    activeClients.delete(client);

    // Closing the client doesn't end the upstream-facing pipe; do that
    // explicitly so the downstream's stdin-EOF hook fires its graceful shutdown.
    pipes.clientToServer.end();
    await downstream.done;
    activeDownstreams.delete(downstream);

    await runtime.dispose();
    activeRuntimes.delete(runtime);
  }, 15_000);
});
