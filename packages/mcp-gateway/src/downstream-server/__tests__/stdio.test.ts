import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { createNoopLogger } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createDownstreamStdioServer } from '../stdio.js';
import type { DownstreamStdioServer } from '../types.js';

const activeServers = new Set<DownstreamStdioServer>();

function track(server: DownstreamStdioServer): DownstreamStdioServer {
  activeServers.add(server);
  return server;
}

afterEach(async () => {
  for (const server of activeServers) {
    await server.stop().catch(() => undefined);
  }
  activeServers.clear();
});

class FakeProcess extends EventEmitter {}

function lifecycleDeps(
  overrides: {
    process?: FakeProcess;
    stdin?: Readable;
    stdout?: Writable;
  } = {},
): {
  process: NodeJS.Process;
  stdin: Readable;
  stdout: Writable;
} {
  return {
    process: (overrides.process ?? new FakeProcess()) as unknown as NodeJS.Process,
    stdin: overrides.stdin ?? new PassThrough(),
    stdout: overrides.stdout ?? new PassThrough(),
  };
}

describe('createDownstreamStdioServer — protocol surface (in-memory transport)', () => {
  it('completes initialize and advertises tools.listChanged capability', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const downstream = createDownstreamStdioServer({
      logger: createNoopLogger(),
      ...lifecycleDeps(),
    });
    await downstream.server.connect(serverTransport);

    const client = new Client(
      { name: 'toolbox-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toMatchObject({ name: 'toolbox' });
    expect(client.getServerCapabilities()?.tools).toMatchObject({ listChanged: true });

    await client.close();
    await downstream.server.close();
  });

  it('returns a tool-execution error to the client when a registered handler throws, and keeps the stream alive', async () => {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const downstream = createDownstreamStdioServer({
      logger: createNoopLogger(),
      registerHandlers: (server) => {
        server.setRequestHandler(CallToolRequestSchema, () => {
          throw new McpError(ErrorCode.InternalError, 'kaboom');
        });
      },
      ...lifecycleDeps(),
    });
    await downstream.server.connect(serverTransport);

    const client = new Client(
      { name: 'toolbox-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    await expect(client.callTool({ name: 'whatever', arguments: {} })).rejects.toBeInstanceOf(
      McpError,
    );
    // Stream is intact: subsequent ping still works.
    await expect(client.ping()).resolves.toBeDefined();

    await client.close();
    await downstream.server.close();
  });
});

describe('createDownstreamStdioServer — lifecycle', () => {
  it('invokes registerHandlers with the SDK server before connect', async () => {
    let registered: unknown = null;
    const downstream = track(
      createDownstreamStdioServer({
        logger: createNoopLogger(),
        registerHandlers: (server) => {
          registered = server;
        },
        ...lifecycleDeps(),
      }),
    );

    await downstream.start();
    expect(registered).toBe(downstream.server);
    await downstream.stop();
  });

  it('rejects start() and resolves done when registerHandlers throws', async () => {
    const downstream = track(
      createDownstreamStdioServer({
        logger: createNoopLogger(),
        registerHandlers: () => {
          throw new Error('register boom');
        },
        ...lifecycleDeps(),
      }),
    );

    await expect(downstream.start()).rejects.toThrow('register boom');
    await expect(downstream.done).resolves.toBeUndefined();
  });

  it('stop() is idempotent and resolves done', async () => {
    const downstream = track(
      createDownstreamStdioServer({
        logger: createNoopLogger(),
        ...lifecycleDeps(),
      }),
    );

    await downstream.start();
    const first = downstream.stop();
    const second = downstream.stop();
    await Promise.all([first, second]);
    await expect(downstream.done).resolves.toBeUndefined();
    await expect(downstream.stop()).resolves.toBeUndefined();
  });

  it('shuts down on SIGINT delivered through the injected process', async () => {
    const fakeProcess = new FakeProcess();
    const downstream = track(
      createDownstreamStdioServer({
        logger: createNoopLogger(),
        ...lifecycleDeps({ process: fakeProcess }),
      }),
    );

    await downstream.start();
    fakeProcess.emit('SIGINT', 'SIGINT');
    await expect(downstream.done).resolves.toBeUndefined();
  });

  it('shuts down on SIGTERM delivered through the injected process', async () => {
    const fakeProcess = new FakeProcess();
    const downstream = track(
      createDownstreamStdioServer({
        logger: createNoopLogger(),
        ...lifecycleDeps({ process: fakeProcess }),
      }),
    );

    await downstream.start();
    fakeProcess.emit('SIGTERM', 'SIGTERM');
    await expect(downstream.done).resolves.toBeUndefined();
  });

  it('shuts down on stdin EOF', async () => {
    const stdin = new PassThrough();
    const downstream = track(
      createDownstreamStdioServer({
        logger: createNoopLogger(),
        ...lifecycleDeps({ stdin: stdin as unknown as Readable }),
      }),
    );

    await downstream.start();
    stdin.end();
    await expect(downstream.done).resolves.toBeUndefined();
  });

  it('removes signal listeners after shutdown', async () => {
    const fakeProcess = new FakeProcess();
    const downstream = track(
      createDownstreamStdioServer({
        logger: createNoopLogger(),
        ...lifecycleDeps({ process: fakeProcess }),
      }),
    );

    await downstream.start();
    expect(fakeProcess.listenerCount('SIGINT')).toBe(1);
    expect(fakeProcess.listenerCount('SIGTERM')).toBe(1);

    await downstream.stop();
    expect(fakeProcess.listenerCount('SIGINT')).toBe(0);
    expect(fakeProcess.listenerCount('SIGTERM')).toBe(0);
  });

  it('rejects a second start() call', async () => {
    const downstream = track(
      createDownstreamStdioServer({
        logger: createNoopLogger(),
        ...lifecycleDeps(),
      }),
    );

    await downstream.start();
    await expect(downstream.start()).rejects.toThrow(/already/);
  });
});
