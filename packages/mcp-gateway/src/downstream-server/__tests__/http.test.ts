import { EventEmitter } from 'node:events';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createNoopLogger } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createDownstreamHttpServer } from '../http.js';
import type { DownstreamHttpServer } from '../types.js';

const activeServers = new Set<DownstreamHttpServer>();
const activeClients = new Set<Client>();

function track<T extends DownstreamHttpServer>(server: T): T {
  activeServers.add(server);
  return server;
}

function trackClient(client: Client): Client {
  activeClients.add(client);
  return client;
}

afterEach(async () => {
  for (const client of activeClients) {
    await client.close().catch(() => undefined);
  }
  activeClients.clear();
  for (const server of activeServers) {
    await server.stop().catch(() => undefined);
  }
  activeServers.clear();
});

class FakeProcess extends EventEmitter {}

interface MakeServerOpts {
  registerHandlers?: Parameters<typeof createDownstreamHttpServer>[0]['registerHandlers'];
  process?: FakeProcess;
  drainTimeoutMs?: number;
  path?: string;
}

function makeServer(opts: MakeServerOpts = {}): DownstreamHttpServer {
  return track(
    createDownstreamHttpServer({
      logger: createNoopLogger(),
      http: { host: '127.0.0.1', port: 0, path: opts.path ?? '/mcp' },
      ...(opts.registerHandlers ? { registerHandlers: opts.registerHandlers } : {}),
      ...(opts.process ? { process: opts.process as unknown as NodeJS.Process } : {}),
      ...(opts.drainTimeoutMs !== undefined ? { drainTimeoutMs: opts.drainTimeoutMs } : {}),
    }),
  );
}

async function connectClient(url: URL): Promise<Client> {
  const client = trackClient(
    new Client({ name: 'toolbox-http-test-client', version: '0.0.0' }, { capabilities: {} }),
  );
  // Cast bridges the SDK's getter/setter-typed optional fields to the
  // strictly-optional Transport interface under exactOptionalPropertyTypes.
  await client.connect(new StreamableHTTPClientTransport(url) as Transport);
  return client;
}

describe('createDownstreamHttpServer — protocol surface', () => {
  it('completes initialize and tools/list against a real loopback listener', async () => {
    const server = makeServer({
      registerHandlers: (mcpServer) => {
        mcpServer.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: [
            {
              name: 'placeholder__noop',
              description: 'placeholder',
              inputSchema: { type: 'object' },
            },
          ],
        }));
      },
    });
    await server.start();

    expect(server.url.hostname).toBe('127.0.0.1');
    expect(server.url.port).not.toBe('');
    expect(server.url.port).not.toBe('0');
    expect(server.url.pathname).toBe('/mcp');

    const client = await connectClient(server.url);
    expect(client.getServerVersion()).toMatchObject({ name: 'toolbox' });
    expect(client.getServerCapabilities()?.tools).toMatchObject({ listChanged: true });

    const result = await client.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe('placeholder__noop');
  });

  it('returns 404 JSON for requests outside the configured MCP path', async () => {
    const server = makeServer();
    await server.start();

    const url = new URL('/something-else', server.url);
    const res = await fetch(url, { method: 'GET' });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'not found' });
  });

  it('returns 400 JSON when a non-initialize POST arrives without a session id', async () => {
    const server = makeServer();
    await server.start();

    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mcp-session-id/);
  });

  it('returns 400 JSON for a GET without a session id', async () => {
    const server = makeServer();
    await server.start();

    const res = await fetch(server.url, { method: 'GET' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mcp-session-id/);
  });

  it('returns 405 JSON for an unsupported HTTP method on the MCP path', async () => {
    const server = makeServer();
    await server.start();

    const res = await fetch(server.url, { method: 'PUT' });

    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/method PUT/);
  });

  it('returns 400 JSON when the POST body is not valid JSON', async () => {
    const server = makeServer();
    await server.start();

    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{not-json',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/JSON/);
  });

  it('survives a handler throwing and keeps subsequent calls working on the same session', async () => {
    let calls = 0;
    const server = makeServer({
      registerHandlers: (mcpServer) => {
        mcpServer.setRequestHandler(CallToolRequestSchema, () => {
          calls++;
          if (calls === 1) {
            throw new Error('first-call failure');
          }
          return { content: [{ type: 'text', text: 'ok' }] };
        });
      },
    });
    await server.start();

    const client = await connectClient(server.url);
    await expect(client.callTool({ name: 'whatever', arguments: {} })).rejects.toThrow();
    const second = await client.callTool({ name: 'whatever', arguments: {} });
    expect(second).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('honours a custom MCP path', async () => {
    const server = makeServer({ path: '/custom/mcp' });
    await server.start();

    expect(server.url.pathname).toBe('/custom/mcp');

    const client = await connectClient(server.url);
    await expect(client.ping()).resolves.toBeDefined();

    const res404 = await fetch(new URL('/mcp', server.url));
    expect(res404.status).toBe(404);
  });
});

describe('createDownstreamHttpServer — lifecycle', () => {
  it('throws when accessing url before start()', () => {
    const server = makeServer();
    expect(() => server.url).toThrow(/not started/);
  });

  it('stop() is idempotent and resolves done', async () => {
    const server = makeServer();
    await server.start();

    const first = server.stop();
    const second = server.stop();
    await Promise.all([first, second]);
    await expect(server.done).resolves.toBeUndefined();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('stop() before start() resolves done so unconditional teardown does not hang', async () => {
    const server = makeServer();
    await server.stop();
    await expect(server.done).resolves.toBeUndefined();
  });

  it('rejects a second start() call', async () => {
    const server = makeServer();
    await server.start();
    await expect(server.start()).rejects.toThrow(/already/);
  });

  it('shuts down on SIGINT delivered through the injected process', async () => {
    const fakeProcess = new FakeProcess();
    const server = makeServer({ process: fakeProcess });

    await server.start();
    fakeProcess.emit('SIGINT', 'SIGINT');
    await expect(server.done).resolves.toBeUndefined();
  });

  it('shuts down on SIGTERM delivered through the injected process', async () => {
    const fakeProcess = new FakeProcess();
    const server = makeServer({ process: fakeProcess });

    await server.start();
    fakeProcess.emit('SIGTERM', 'SIGTERM');
    await expect(server.done).resolves.toBeUndefined();
  });

  it('removes signal listeners after shutdown', async () => {
    const fakeProcess = new FakeProcess();
    const server = makeServer({ process: fakeProcess });

    await server.start();
    expect(fakeProcess.listenerCount('SIGINT')).toBe(1);
    expect(fakeProcess.listenerCount('SIGTERM')).toBe(1);

    await server.stop();
    expect(fakeProcess.listenerCount('SIGINT')).toBe(0);
    expect(fakeProcess.listenerCount('SIGTERM')).toBe(0);
  });

  it('drains an in-flight request on stop() before resolving', async () => {
    let release!: () => void;
    const releasing = new Promise<void>((resolve) => {
      release = resolve;
    });

    const server = makeServer({
      drainTimeoutMs: 5_000,
      registerHandlers: (mcpServer) => {
        mcpServer.setRequestHandler(CallToolRequestSchema, async () => {
          await releasing;
          return { content: [{ type: 'text', text: 'late' }] };
        });
      },
    });
    await server.start();

    const client = await connectClient(server.url);
    const callPromise = client.callTool({ name: 'whatever', arguments: {} });

    // Give the call a moment to land on the server.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stopPromise = server.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });

    // Stop must wait — the slow call is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopped).toBe(false);

    release();
    const result = await callPromise;
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'late' }] });

    await stopPromise;
    expect(stopped).toBe(true);
    await expect(server.done).resolves.toBeUndefined();
  });

  it('forces sockets closed when in-flight requests exceed the drain timeout', async () => {
    // Use a raw fetch (not the SDK client) so we own the request lifecycle
    // and can verify the server forcibly closes the socket without other
    // SSE machinery (notification stream, reconnection logic) interfering.
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const server = makeServer({
      drainTimeoutMs: 75,
      registerHandlers: (mcpServer) => {
        mcpServer.setRequestHandler(CallToolRequestSchema, async () => {
          await blocker;
          return { content: [] };
        });
      },
    });
    await server.start();

    // Initialize a session via raw HTTP so we get a session id back.
    const initRes = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'raw-test-client', version: '0.0.0' },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await initRes.body?.cancel();

    // Send the slow tools/call but DON'T await — the handler will block
    // until we release it.
    const callPromise = fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'whatever', arguments: {} },
      }),
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const t0 = Date.now();
    await server.stop();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(elapsed).toBeLessThan(2_000);
    await expect(server.done).resolves.toBeUndefined();

    // Release the in-flight handler so the test process can exit cleanly.
    release();
    await callPromise;
  });
});
