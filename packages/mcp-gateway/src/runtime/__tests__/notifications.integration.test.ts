import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createIntegrationHarness,
  makeIntegrationConfig,
  startHarness,
} from './__fixtures__/integration-helpers.js';

const harness = createIntegrationHarness();

afterEach(async () => {
  await harness.cleanup();
});

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

async function connectCountingClient(url: URL, name: string): Promise<NotificationCounter> {
  const client = new Client({ name, version: '0.0.0' }, { capabilities: {} });
  harness.clients.add(client);
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
    const config = makeIntegrationConfig({
      progressiveDisclosure: { bootstrapTools: true },
    });
    const { downstream } = await startHarness({ config, harness });

    const counter = await connectCountingClient(downstream.url, 'reveal-test');

    await counter.client.callTool({
      name: 'toolbox__reveal_tools',
      arguments: { tools: ['echo__echo', 'echo__slow'] },
    });

    // Allow the 50ms debounce window plus scheduling slack to elapse.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(counter.count()).toBe(1);
  }, 15_000);

  it('an upstream tool-set change notifies every active downstream session', async () => {
    const config = makeIntegrationConfig({
      progressiveDisclosure: { bootstrapTools: true },
    });
    const { runtime, downstream } = await startHarness({ config, harness });

    const counterA = await connectCountingClient(downstream.url, 'upstream-test-a');
    const counterB = await connectCountingClient(downstream.url, 'upstream-test-b');

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
    const config = makeIntegrationConfig({
      progressiveDisclosure: { bootstrapTools: true },
    });
    const { runtime, downstream } = await startHarness({ config, harness });

    const counterA = await connectCountingClient(downstream.url, 'broadcast-test-a');
    const counterB = await connectCountingClient(downstream.url, 'broadcast-test-b');

    runtime.notifyAllSessionsToolsChanged();

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(counterA.count()).toBe(1);
    expect(counterB.count()).toBe(1);
  }, 15_000);

  it('detaches per-session listeners on session close so a closed client is not still scheduled', async () => {
    const config = makeIntegrationConfig({
      progressiveDisclosure: { bootstrapTools: true },
    });
    const { runtime, downstream } = await startHarness({ config, harness });

    const counterA = await connectCountingClient(downstream.url, 'cleanup-test-a');
    const counterB = await connectCountingClient(downstream.url, 'cleanup-test-b');

    // Close client A and let the transport finalise.
    await counterA.client.close();
    harness.clients.delete(counterA.client);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A registry change after A's close should still notify B exactly once
    // and must not throw inside A's now-disposed notifier.
    runtime.toolRegistry.setServerEntry({
      serverName: 'echo',
      status: { kind: 'connected', since: new Date() },
      enabled: true,
      tools: [tool('echo'), tool('emit_log'), tool('slow'), tool('shout')],
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(counterB.count()).toBe(1);
    expect(counterA.count()).toBe(0);
  }, 15_000);

  it('hide_tools that removes nothing emits no notification (no visibility change)', async () => {
    const config = makeIntegrationConfig({
      progressiveDisclosure: { bootstrapTools: true },
    });
    const { downstream } = await startHarness({ config, harness });

    const counter = await connectCountingClient(downstream.url, 'hide-noop-test');

    await counter.client.callTool({
      name: 'toolbox__hide_tools',
      arguments: { tools: ['echo__echo'] },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(counter.count()).toBe(0);
  }, 15_000);
});
