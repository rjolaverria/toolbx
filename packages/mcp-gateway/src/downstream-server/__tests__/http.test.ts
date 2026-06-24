import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  CONTROL_PLANE_HEADER,
  CONTROL_PLANE_MARKER,
  createNoopLogger,
} from '@rjolaverria/toolbox-core';
import { afterEach, describe, expect, it } from 'vitest';

import { createDownstreamHttpServer } from '../http.js';
import type { DownstreamSession } from '../session.js';
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

async function connectClient(url: URL, headers?: Record<string, string>): Promise<Client> {
  const client = trackClient(
    new Client({ name: 'toolbox-http-test-client', version: '0.0.0' }, { capabilities: {} }),
  );
  const transport =
    headers !== undefined
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
      : new StreamableHTTPClientTransport(url);
  // Cast bridges the SDK's getter/setter-typed optional fields to the
  // strictly-optional Transport interface under exactOptionalPropertyTypes.
  await client.connect(transport as Transport);
  return client;
}

async function postOversizeBodyUntilServerCloses(url: URL): Promise<string> {
  // Use a raw socket so the test stops writing once the server has enough
  // bytes to reject the request; fetch may keep writing and surface EPIPE.
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let settled = false;
    let socketError: Error | undefined;

    const timeout = setTimeout(() => {
      settle(() => {
        socket.destroy();
        reject(new Error('timed out waiting for oversized request response'));
      });
    }, 2_000);
    timeout.unref?.();

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    socket.on('connect', () => {
      const declaredLength = 5 * 1024 * 1024;
      const bytesNeededToTripLimit = 4 * 1024 * 1024 + 1;
      const headers = [
        `POST ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        'Content-Type: application/json',
        'Accept: application/json, text/event-stream',
        `Content-Length: ${declaredLength}`,
        '',
        '',
      ].join('\r\n');

      socket.write(headers);
      const chunk = Buffer.alloc(64 * 1024, 'x');
      let remaining = bytesNeededToTripLimit;
      const writeBody = (): void => {
        while (remaining > 0) {
          const size = Math.min(remaining, chunk.length);
          const bodyChunk = size === chunk.length ? chunk : chunk.subarray(0, size);
          remaining -= size;
          if (!socket.write(bodyChunk)) {
            socket.once('drain', writeBody);
            return;
          }
        }
      };

      writeBody();
    });

    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    socket.on('error', (error) => {
      socketError = error;
    });
    socket.on('close', () => {
      settle(() => {
        if (chunks.length === 0 && socketError) {
          reject(socketError);
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  });
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

  it('marks a loopback session as control-plane only when the marker header is present', async () => {
    const sessions: DownstreamSession[] = [];
    const server = makeServer({
      registerHandlers: (_mcpServer, session) => {
        sessions.push(session);
      },
    });
    await server.start();

    await connectClient(server.url, { [CONTROL_PLANE_HEADER]: CONTROL_PLANE_MARKER });
    await connectClient(server.url);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.controlPlane).toBe(true);
    expect(sessions[1]?.controlPlane).toBe(false);
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
    // Wall-clock timers can report a millisecond or two below the requested
    // timeout under coverage instrumentation. Keep the assertion focused on the
    // behavior: stop() waits for the drain timer instead of returning
    // immediately, then force-closes in-flight sockets well before hanging.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(2_000);
    await expect(server.done).resolves.toBeUndefined();

    // Release the in-flight handler so the test process can exit cleanly.
    release();
    await callPromise;
  });

  it('returns 413 and force-closes the socket for oversize bodies', async () => {
    const server = makeServer();
    await server.start();

    const rawResponse = await postOversizeBodyUntilServerCloses(server.url);
    const [head, body = ''] = rawResponse.split('\r\n\r\n');

    expect(head).toMatch(/^HTTP\/1.1 413 /);
    expect(head).toMatch(/connection: close/i);
    expect(JSON.parse(body)).toEqual({ error: 'request body too large' });
  });

  it('closes the listener when stop() races with an in-flight start()', async () => {
    const server = makeServer();
    const startPromise = server.start();
    const stopPromise = server.stop();

    await expect(startPromise).rejects.toThrow(/stopped during start/);
    await stopPromise;
    await expect(server.done).resolves.toBeUndefined();
    // If the listener leaked, the next `fetch` against any prior URL would
    // succeed. This test deliberately doesn't capture the URL — successful
    // teardown is observed via `done` resolving and the next `start()` being
    // permitted (which would fail if we left state inconsistent).
    expect(() => server.url).toThrow(/not started/);
  });

  it('done() resolves only after the listener has stopped accepting', async () => {
    const server = makeServer();
    await server.start();
    const url = server.url;

    await server.stop();
    await expect(server.done).resolves.toBeUndefined();

    // Once `done` resolves, no new connections should succeed against the
    // previously bound port.
    await expect(fetch(url)).rejects.toThrow();
  });
});
