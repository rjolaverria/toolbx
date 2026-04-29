import http from 'node:http';

import { createNoopLogger, type HttpServerConfig } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  UpstreamAuthRequiredError,
  UpstreamCallToolTimeoutError,
  UpstreamConnectError,
  UpstreamMissingEnvVarError,
  UpstreamNotConnectedError,
} from '../errors.js';
import { createHttpUpstreamClient } from '../http.js';
import type { UpstreamClient } from '../types.js';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — `.mjs` fixture has no .d.ts but exports a typed shape we
// describe inline below.
import { startHttpEchoServer } from './__fixtures__/http-echo-server.mjs';

interface HttpEchoServerOptions {
  requireBearerToken?: string;
  requireHeaders?: Record<string, string>;
}
interface HttpEchoServer {
  url: string;
  close: () => Promise<void>;
}
const startServer = startHttpEchoServer as (
  options?: HttpEchoServerOptions,
) => Promise<HttpEchoServer>;

const activeClients = new Set<UpstreamClient>();
const activeServers = new Set<HttpEchoServer>();

function track(client: UpstreamClient): UpstreamClient {
  activeClients.add(client);
  return client;
}

async function startTrackedServer(options?: HttpEchoServerOptions): Promise<HttpEchoServer> {
  const server = await startServer(options);
  activeServers.add(server);
  return server;
}

function httpConfig(overrides: Partial<HttpServerConfig> & { url: string }): HttpServerConfig {
  return {
    type: 'http',
    enabled: true,
    ...overrides,
  };
}

afterEach(async () => {
  for (const client of activeClients) {
    await client.disconnect().catch(() => undefined);
  }
  activeClients.clear();
  for (const server of activeServers) {
    await server.close().catch(() => undefined);
  }
  activeServers.clear();
});

describe('createHttpUpstreamClient — connect', () => {
  it('connects, lists tools, and calls a tool against a real HTTP MCP server', async () => {
    const server = await startTrackedServer();
    const client = track(
      createHttpUpstreamClient(httpConfig({ url: server.url }), { logger: createNoopLogger() }),
    );

    await client.connect();

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['echo', 'slow']);

    const result = await client.callTool('echo', { message: 'hi over http' });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'hi over http' }],
    });
  });

  it('rejects with UpstreamConnectError when the URL is unreachable', async () => {
    // Bind to an ephemeral port, then immediately close so nothing is
    // listening on it. This is more reliable across CI hosts than guessing
    // a "free" port.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const address = probe.address();
    if (address === null || typeof address === 'string') {
      throw new Error('failed to obtain ephemeral port');
    }
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const client = track(
      createHttpUpstreamClient(httpConfig({ url: `http://127.0.0.1:${port}/mcp` }), {
        logger: createNoopLogger(),
        connectTimeoutMs: 1_000,
      }),
    );

    await expect(client.connect()).rejects.toBeInstanceOf(UpstreamConnectError);
  });

  it('rejects with UpstreamConnectError when the URL serves a non-MCP response', async () => {
    const plainServer = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end('<html>not an MCP server</html>');
    });
    await new Promise<void>((resolve) => plainServer.listen(0, '127.0.0.1', () => resolve()));
    const address = plainServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('failed to bind plain http server');
    }
    const url = `http://127.0.0.1:${address.port}/`;

    try {
      const client = track(
        createHttpUpstreamClient(httpConfig({ url }), {
          logger: createNoopLogger(),
          connectTimeoutMs: 2_000,
        }),
      );

      await expect(client.connect()).rejects.toBeInstanceOf(UpstreamConnectError);
    } finally {
      await new Promise<void>((resolve) => plainServer.close(() => resolve()));
    }
  });

  it('rejects with UpstreamAuthRequiredError when a bearer token env var is unset', async () => {
    const client = track(
      createHttpUpstreamClient(
        httpConfig({
          url: 'http://127.0.0.1:1/mcp',
          auth: { type: 'bearer', tokenEnv: 'TOOLBOX_TEST_MISSING_BEARER' },
        }),
        {
          logger: createNoopLogger(),
          processEnv: {},
          serverName: 'fake',
        },
      ),
    );

    let caught: unknown;
    try {
      await client.connect();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UpstreamAuthRequiredError);
    if (caught instanceof UpstreamAuthRequiredError) {
      expect(caught.tokenEnv).toBe('TOOLBOX_TEST_MISSING_BEARER');
      expect(caught.serverName).toBe('fake');
    }
  });

  it('sends the bearer token from the configured env var as Authorization header', async () => {
    const server = await startTrackedServer({ requireBearerToken: 's3cret' });

    const client = track(
      createHttpUpstreamClient(
        httpConfig({
          url: server.url,
          auth: { type: 'bearer', tokenEnv: 'TOOLBOX_TEST_BEARER' },
        }),
        {
          logger: createNoopLogger(),
          processEnv: { TOOLBOX_TEST_BEARER: 's3cret' },
        },
      ),
    );

    await client.connect();
    const result = await client.callTool('echo', { message: 'authed' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'authed' }] });
  });

  it('treats `auth: { type: "none" }` as no Authorization header', async () => {
    const server = await startTrackedServer();
    const client = track(
      createHttpUpstreamClient(httpConfig({ url: server.url, auth: { type: 'none' } }), {
        logger: createNoopLogger(),
      }),
    );

    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('resolves ${env:VAR} placeholders in headers', async () => {
    const server = await startTrackedServer({ requireHeaders: { 'x-toolbox-test': 'resolved' } });

    const client = track(
      createHttpUpstreamClient(
        httpConfig({
          url: server.url,
          headers: { 'X-Toolbox-Test': '${env:TOOLBOX_TEST_HEADER}' },
        }),
        {
          logger: createNoopLogger(),
          processEnv: { TOOLBOX_TEST_HEADER: 'resolved' },
        },
      ),
    );

    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('throws UpstreamMissingEnvVarError when a header ${env:VAR} placeholder is unset', async () => {
    const client = track(
      createHttpUpstreamClient(
        httpConfig({
          url: 'http://127.0.0.1:1/mcp',
          headers: { 'X-Toolbox-Test': '${env:TOOLBOX_TEST_MISSING_HEADER}' },
        }),
        {
          logger: createNoopLogger(),
          processEnv: {},
          serverName: 'fake',
        },
      ),
    );

    await expect(client.connect()).rejects.toBeInstanceOf(UpstreamMissingEnvVarError);
  });
});

describe('createHttpUpstreamClient — disconnect', () => {
  it('is idempotent — calling disconnect() twice is safe', async () => {
    const server = await startTrackedServer();
    const client = track(
      createHttpUpstreamClient(httpConfig({ url: server.url }), { logger: createNoopLogger() }),
    );

    await client.connect();
    await client.disconnect();
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it('disconnect on an idle client is a no-op', async () => {
    const client = track(
      createHttpUpstreamClient(httpConfig({ url: 'http://127.0.0.1:1/mcp' }), {
        logger: createNoopLogger(),
      }),
    );
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it('throws UpstreamNotConnectedError when callTool is invoked after disconnect', async () => {
    const server = await startTrackedServer();
    const client = track(
      createHttpUpstreamClient(httpConfig({ url: server.url }), { logger: createNoopLogger() }),
    );
    await client.connect();
    await client.disconnect();

    await expect(client.callTool('echo', { message: 'after-close' })).rejects.toBeInstanceOf(
      UpstreamNotConnectedError,
    );
  });

  it('emits exit exactly once on intentional disconnect', async () => {
    const server = await startTrackedServer();
    const client = track(
      createHttpUpstreamClient(httpConfig({ url: server.url }), { logger: createNoopLogger() }),
    );

    const exits: Array<{ intentional: boolean }> = [];
    client.on('exit', (info) => {
      exits.push(info);
    });

    await client.connect();
    await client.disconnect();
    await client.disconnect();

    expect(exits).toEqual([{ intentional: true }]);
  });
});

describe('createHttpUpstreamClient — callTool timeout', () => {
  it('rejects with UpstreamCallToolTimeoutError that names the offending tool', async () => {
    const server = await startTrackedServer();
    const client = track(
      createHttpUpstreamClient(httpConfig({ url: server.url }), { logger: createNoopLogger() }),
    );
    await client.connect();

    let caught: unknown;
    try {
      await client.callTool('slow', { delayMs: 5_000 }, { timeoutMs: 50 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UpstreamCallToolTimeoutError);
    if (caught instanceof UpstreamCallToolTimeoutError) {
      expect(caught.toolName).toBe('slow');
      expect(caught.timeoutMs).toBe(50);
    }
  });

  it('honors timeoutMs from the server config when no per-call override is provided', async () => {
    const server = await startTrackedServer();
    const client = track(
      createHttpUpstreamClient(httpConfig({ url: server.url, timeoutMs: 50 }), {
        logger: createNoopLogger(),
      }),
    );
    await client.connect();

    let caught: unknown;
    try {
      await client.callTool('slow', { delayMs: 5_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UpstreamCallToolTimeoutError);
    if (caught instanceof UpstreamCallToolTimeoutError) {
      expect(caught.timeoutMs).toBe(50);
    }
  });
});

describe('createHttpUpstreamClient — ping', () => {
  it('round-trips a ping against the upstream server', async () => {
    const server = await startTrackedServer();
    const client = track(
      createHttpUpstreamClient(httpConfig({ url: server.url }), { logger: createNoopLogger() }),
    );
    await client.connect();
    await expect(client.ping()).resolves.toBeUndefined();
  });
});

describe('createHttpUpstreamClient — interface compatibility', () => {
  it('produces an UpstreamClient that is assignable to the shared interface', () => {
    const c: UpstreamClient = createHttpUpstreamClient(
      httpConfig({ url: 'http://127.0.0.1:1/mcp' }),
      { logger: createNoopLogger() },
    );
    expect(typeof c.connect).toBe('function');
    expect(typeof c.callTool).toBe('function');
  });
});
