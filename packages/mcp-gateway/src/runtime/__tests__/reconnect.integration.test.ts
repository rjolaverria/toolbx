import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CRASHABLE_FIXTURE,
  createIntegrationHarness,
  makeIntegrationConfig,
  startHarness,
  waitFor,
} from './__fixtures__/integration-helpers.js';

const harness = createIntegrationHarness();

afterEach(async () => {
  await harness.cleanup();
});

describe('gateway upstream reconnect on unexpected upstream exit', () => {
  it('moves the server to error then back to connected, and notifies the downstream session', async () => {
    const config = makeIntegrationConfig({
      servers: {
        crashable: {
          type: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [CRASHABLE_FIXTURE],
        },
      },
    });

    const { runtime, downstream } = await startHarness({ config, harness });

    const client = new Client(
      { name: 'toolbx-reconnect-it', version: '0.0.0' },
      { capabilities: {} },
    );
    harness.clients.add(client);

    let toolsListChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      toolsListChanged += 1;
      return Promise.resolve();
    });

    await client.connect(new StreamableHTTPClientTransport(downstream.url) as Transport);

    // Sanity check: the upstream is up and the crash tool is exposed.
    const before = await client.listTools();
    const exposedBefore = before.tools.map((t) => t.name).sort();
    expect(exposedBefore).toEqual(['crashable__crash', 'crashable__echo']);
    expect(runtime.statusRegistry.get('crashable')?.status.kind).toBe('connected');

    // Trigger the crash. The fixture exits with code 1; the in-flight
    // request will fail because the transport closes mid-call, so swallow
    // that rejection — the assertion that matters is the status transition.
    await client.callTool({ name: 'crashable__crash', arguments: {} }).catch(() => undefined);

    // The session's recovery loop moves the server through `error` (failure
    // observed, backoff scheduled) and `starting` (retry attempt #2) before
    // reaching `connected` again.
    await waitFor(() => runtime.statusRegistry.get('crashable')?.status.kind === 'error', 10_000);
    await waitFor(
      () => runtime.statusRegistry.get('crashable')?.status.kind === 'connected',
      10_000,
    );

    // The crash drops the upstream's tool set out of the registry and the
    // reconnect re-populates it; both visibility changes fan out a
    // `tools/list_changed`. The debounce window collapses bursts inside a
    // single transition, but the disconnect and reconnect happen across the
    // backoff gap (~500ms) and are reported separately.
    await waitFor(() => toolsListChanged >= 1, 5000);
    expect(toolsListChanged).toBeGreaterThanOrEqual(1);

    // The reconnected upstream is callable again.
    const after = await client.callTool({
      name: 'crashable__echo',
      arguments: { message: 'recovered' },
    });
    expect(after.content).toEqual([{ type: 'text', text: 'recovered' }]);
  }, 30_000);
});
