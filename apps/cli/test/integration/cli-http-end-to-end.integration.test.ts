// End-to-end CLI integration test for the HTTP downstream + HTTP upstream
// path. Drives `tlbx server add-http` to register a remote MCP server and
// then connects an MCP SDK client to ToolBox over Streamable HTTP. Covers
// SPECS §4.8 acceptance criteria 3, 4, 5, 6, 7.
//
// The fixture upstream is `http-echo-server.mjs` from M1-02, run in-process
// so the test never touches the network beyond loopback.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { loadConfig } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultServerAddDeps, runAddHttp } from '../../src/commands/server-add.js';

import {
  HTTP_ECHO_FIXTURE_MODULE,
  makeConfig,
  makeTempConfig,
  startInProcessServe,
  waitFor,
  type InProcessServeHandle,
  type TempConfigHandle,
} from './helpers.js';

// `.mjs` fixtures don't ship .d.ts files; describe their typed shape here
// rather than reaching for `any`.
interface HttpEchoServer {
  url: string;
  close: () => Promise<void>;
}
interface HttpEchoServerOptions {
  requireBearerToken?: string;
}
interface HttpEchoModule {
  startHttpEchoServer: (options?: HttpEchoServerOptions) => Promise<HttpEchoServer>;
}

const tempConfigs: TempConfigHandle[] = [];
const activeClients = new Set<Client>();
const activeServeHandles = new Set<InProcessServeHandle>();
const activeUpstreams = new Set<HttpEchoServer>();

afterEach(async () => {
  for (const client of activeClients) {
    await client.close().catch(() => undefined);
  }
  activeClients.clear();
  for (const handle of activeServeHandles) {
    await handle.stop().catch(() => undefined);
  }
  activeServeHandles.clear();
  for (const upstream of activeUpstreams) {
    await upstream.close().catch(() => undefined);
  }
  activeUpstreams.clear();
  while (tempConfigs.length > 0) {
    const handle = tempConfigs.pop();
    await handle?.cleanup();
  }
});

async function startHttpEchoUpstream(): Promise<HttpEchoServer> {
  // Dynamic import is the simplest way to load a .mjs fixture from a
  // TypeScript test without a .d.ts companion. The cast localises the
  // unsafe boundary to one place.
  const mod = (await import(HTTP_ECHO_FIXTURE_MODULE)) as HttpEchoModule;
  const server = await mod.startHttpEchoServer();
  activeUpstreams.add(server);
  return server;
}

describe('end-to-end CLI lifecycle (HTTP downstream + HTTP upstream)', () => {
  it('server add-http → serve --http → MCP client roundtrip', async () => {
    // 0. Spin up the fake remote MCP server.
    const upstream = await startHttpEchoUpstream();

    // 1. Seed a fresh config and `tlbx server add-http` against the upstream
    //    URL (acceptance criterion #3).
    // Disable progressive disclosure + the bootstrap surface so this test
    // can assert the full namespaced catalogue with `toEqual`. The disclosure
    // path has its own dedicated integration test. Bind the downstream HTTP
    // server to an ephemeral port so parallel suites don't collide on 7331.
    const seedConfig = await makeConfig({
      progressiveDisclosure: { enabled: false, bootstrapTools: false },
      servers: {},
    });
    const handle = await makeTempConfig(seedConfig);
    tempConfigs.push(handle);

    // Pin `--auth none` so add-http skips the discovery probe: this test
    // exercises the add → serve → roundtrip path, not auth discovery (which is
    // covered by the server-add unit tests). Probing the single-session echo
    // upstream here would open and tear down an MCP session before serve's own
    // connection, which the fixture cannot disambiguate.
    const addCode = await runAddHttp(
      'remote',
      { url: upstream.url, config: handle.target, auth: 'none' },
      defaultServerAddDeps(),
    );
    expect(addCode).toBe(0);
    const afterAdd = await loadConfig(handle.target);
    expect(afterAdd.servers['remote']).toMatchObject({
      type: 'http',
      enabled: true,
      url: upstream.url,
    });

    // 2. Start ToolBox in-process via runServe and grab the bound URL from
    //    the onStarted callback (acceptance criteria #4, #5).
    const serveHandle = await startInProcessServe({
      configPath: handle.target,
      mode: 'http',
    });
    activeServeHandles.add(serveHandle);
    const url = serveHandle.info.url;
    expect(url).toBeDefined();
    if (url === undefined) {
      throw new Error('http serve did not surface a bound URL');
    }

    // 3. Wait for the upstream session to reach `connected` so tools/list is
    //    populated rather than empty.
    await waitFor(
      () => serveHandle.info.runtime.statusRegistry.get('remote')?.status.kind === 'connected',
    );

    // 4. Connect an MCP client to ToolBox and exercise tools/list /
    //    tools/call (acceptance criteria #6, #7).
    const client = new Client(
      { name: 'toolbox-cli-http-it', version: '0.0.0' },
      { capabilities: {} },
    );
    activeClients.add(client);
    await client.connect(new StreamableHTTPClientTransport(url) as Transport);

    expect(client.getServerVersion()?.name).toBe('toolbox');

    const list = await client.listTools();
    const exposed = list.tools.map((t) => t.name).sort();
    expect(exposed).toEqual(['remote__echo', 'remote__slow']);

    const result = await client.callTool({
      name: 'remote__echo',
      arguments: { message: 'hello over http' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'hello over http' }]);

    await client.close();
    activeClients.delete(client);

    await serveHandle.stop();
    activeServeHandles.delete(serveHandle);
  }, 30_000);
});
