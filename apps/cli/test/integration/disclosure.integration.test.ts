// Progressive disclosure integration test. Drives the full
// search → reveal → call → hide cycle through `runServe()` against a real
// stdio upstream fixture, and asserts that `notifications/tools/list_changed`
// fires on the calling session. Covers SPECS §4.8 acceptance criteria 8,
// 9, 10, plus the M4-06 notification wiring.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { BOOTSTRAP_TOOL_NAMES } from '@toolbox/mcp-gateway';

import {
  STDIO_ECHO_FIXTURE,
  makeConfig,
  makeTempConfig,
  startInProcessServe,
  waitFor,
  type InProcessServeHandle,
  type TempConfigHandle,
} from './helpers.js';

const tempConfigs: TempConfigHandle[] = [];
const activeClients = new Set<Client>();
const activeServeHandles = new Set<InProcessServeHandle>();

afterEach(async () => {
  for (const client of activeClients) {
    await client.close().catch(() => undefined);
  }
  activeClients.clear();
  for (const handle of activeServeHandles) {
    await handle.stop().catch(() => undefined);
  }
  activeServeHandles.clear();
  while (tempConfigs.length > 0) {
    const handle = tempConfigs.pop();
    await handle?.cleanup();
  }
});

interface NotificationCounter {
  count: () => number;
}

function attachToolsListChangedCounter(client: Client): NotificationCounter {
  let received = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    received += 1;
    return Promise.resolve();
  });
  return { count: () => received };
}

describe('progressive disclosure end-to-end', () => {
  it('search → reveal → call → hide cycle with tools/list_changed notifications', async () => {
    // Disclosure ON, with bootstrap tools, to drive the full reveal / hide
    // surface (acceptance criterion #9).
    const config = await makeConfig({
      progressiveDisclosure: { enabled: true, bootstrapTools: true },
      servers: {
        echo: {
          type: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [STDIO_ECHO_FIXTURE],
        },
      },
    });
    const handle = await makeTempConfig(config);
    tempConfigs.push(handle);

    const serveHandle = await startInProcessServe({
      configPath: handle.target,
      mode: 'http',
      configObject: config,
    });
    activeServeHandles.add(serveHandle);
    const url = serveHandle.info.url;
    if (url === undefined) {
      throw new Error('http serve did not surface a bound URL');
    }

    await waitFor(
      () => serveHandle.info.runtime.statusRegistry.get('echo')?.status.kind === 'connected',
    );

    const client = new Client(
      { name: 'toolbox-disclosure-it', version: '0.0.0' },
      { capabilities: {} },
    );
    activeClients.add(client);
    const counter = attachToolsListChangedCounter(client);
    await client.connect(new StreamableHTTPClientTransport(url) as Transport);

    // 1. With disclosure on and nothing revealed, tools/list returns only
    //    the bootstrap surface.
    {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual([...BOOTSTRAP_TOOL_NAMES].sort());
    }

    // 2. Calling a non-revealed namespaced tool is refused with a clear MCP
    //    error pointing the agent at reveal_tools (acceptance criterion #9).
    await expect(
      client.callTool({ name: 'echo__echo', arguments: { message: 'no' } }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });

    // 3. Search surfaces the matching upstream tool by name (acceptance
    //    criterion #10).
    const searchResult = await client.callTool({
      name: 'toolbox__search_tools',
      arguments: { query: 'echo' },
    });
    expect(searchResult.content).toBeDefined();
    const searchText = JSON.stringify(searchResult.content);
    expect(searchText).toContain('echo__echo');

    // 4. Reveal the tool — the call must succeed and emit one
    //    `notifications/tools/list_changed` to this session (M4-06).
    const beforeReveal = counter.count();
    await client.callTool({
      name: 'toolbox__reveal_tools',
      arguments: { tools: ['echo__echo'] },
    });
    // Allow the 50 ms debounce + scheduling slack from
    // createToolsChangedNotifier to elapse.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(counter.count()).toBe(beforeReveal + 1);

    // 5. tools/list now contains the revealed tool alongside the bootstrap
    //    surface, and tools/call routes through to the upstream.
    {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain('echo__echo');
    }
    {
      const result = await client.callTool({
        name: 'echo__echo',
        arguments: { message: 'revealed' },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'revealed' }]);
    }

    // 6. Hide the tool — visibility flips back and another notification
    //    fires.
    const beforeHide = counter.count();
    await client.callTool({
      name: 'toolbox__hide_tools',
      arguments: { tools: ['echo__echo'] },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(counter.count()).toBe(beforeHide + 1);

    {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).not.toContain('echo__echo');
    }

    await client.close();
    activeClients.delete(client);
    await serveHandle.stop();
    activeServeHandles.delete(serveHandle);
  }, 30_000);

  it('toggling progressiveDisclosure.enabled mid-session via runtime + notifyAll fans every tool out', async () => {
    // Disclosure ON to start; we'll flip it via the runtime so the next
    // tools/list returns every namespaced tool (acceptance criterion #8).
    const config = await makeConfig({
      progressiveDisclosure: { enabled: true, bootstrapTools: true },
      servers: {
        echo: {
          type: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [STDIO_ECHO_FIXTURE],
        },
      },
    });
    const handle = await makeTempConfig(config);
    tempConfigs.push(handle);

    const serveHandle = await startInProcessServe({
      configPath: handle.target,
      mode: 'http',
      configObject: config,
    });
    activeServeHandles.add(serveHandle);
    const url = serveHandle.info.url;
    if (url === undefined) {
      throw new Error('http serve did not surface a bound URL');
    }
    await waitFor(
      () => serveHandle.info.runtime.statusRegistry.get('echo')?.status.kind === 'connected',
    );

    const client = new Client(
      { name: 'toolbox-disclosure-toggle-it', version: '0.0.0' },
      { capabilities: {} },
    );
    activeClients.add(client);
    const counter = attachToolsListChangedCounter(client);
    await client.connect(new StreamableHTTPClientTransport(url) as Transport);

    // Disclosure on → bootstrap-only.
    {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual([...BOOTSTRAP_TOOL_NAMES].sort());
    }

    // Flip the live config to disclosure-off and broadcast — the runtime
    // re-reads the flag per request, so the next tools/list returns the
    // upstream catalogue too.
    config.progressiveDisclosure.enabled = false;
    serveHandle.info.runtime.notifyAllSessionsToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(counter.count()).toBeGreaterThanOrEqual(1);

    {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain('echo__echo');
      expect(names).toContain('echo__slow');
      // Bootstrap tools still surface.
      for (const bootstrapName of BOOTSTRAP_TOOL_NAMES) {
        expect(names).toContain(bootstrapName);
      }
    }

    // tools/call routes regardless of reveal state when disclosure is off.
    const result = await client.callTool({
      name: 'echo__slow',
      arguments: { delayMs: 0 },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'slept 0ms' }]);

    await client.close();
    activeClients.delete(client);
    await serveHandle.stop();
    activeServeHandles.delete(serveHandle);
  }, 30_000);
});
