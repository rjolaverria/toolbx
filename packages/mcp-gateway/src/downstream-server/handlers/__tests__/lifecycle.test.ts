import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { createNoopLogger, getToolbxVersion } from '@toolbx/core';
import { describe, expect, it } from 'vitest';

import { buildToolbxMcpServer } from '../../server.js';
import { createDownstreamSession } from '../../session.js';
import { requireReady } from '../lifecycle.js';

async function connectPair(register?: (server: unknown, session: unknown) => void): Promise<{
  client: Client;
  closeAll: () => Promise<void>;
  session: ReturnType<typeof createDownstreamSession>;
}> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const built = buildToolbxMcpServer({
    logger: createNoopLogger(),
    sessionId: 'unit-test',
    ...(register ? { registerHandlers: register } : {}),
  });
  await built.server.connect(serverTransport);

  const client = new Client(
    { name: 'toolbx-lifecycle-test-client', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    client,
    session: built.session,
    closeAll: async () => {
      await client.close();
      await built.server.close();
    },
  };
}

describe('lifecycle handlers — initialize', () => {
  it('reports serverInfo with name=toolbx and version from @toolbx/core package.json', async () => {
    const { client, closeAll } = await connectPair();
    expect(client.getServerVersion()).toEqual({ name: 'toolbx', version: getToolbxVersion() });
    await closeAll();
  });

  it('advertises both tools (with listChanged) and logging capabilities', async () => {
    const { client, closeAll } = await connectPair();
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toMatchObject({ listChanged: true });
    expect(caps?.logging).toBeDefined();
    await closeAll();
  });
});

describe('lifecycle handlers — notifications/initialized', () => {
  it('flips session.ready to true once the client completes the lifecycle', async () => {
    const { closeAll, session } = await connectPair();
    // The SDK's Client.connect() awaits both initialize AND sends the
    // initialized notification before resolving, so by the time we reach
    // here the server's oninitialized has already fired.
    expect(session.ready).toBe(true);
    await closeAll();
  });

  it('keeps session.ready=false on a Server that never received initialized', () => {
    // Build a Server without ever connecting it: oninitialized cannot fire.
    const built = buildToolbxMcpServer({
      logger: createNoopLogger(),
      sessionId: 'never-initialized',
    });
    expect(built.session.ready).toBe(false);
  });
});

describe('lifecycle handlers — pre-init guard', () => {
  it('rejects tools/call with InvalidRequest if invoked before initialized', () => {
    const session = createDownstreamSession('guard-test');
    expect(() => requireReady(session)).toThrow(McpError);
    try {
      requireReady(session);
    } catch (error) {
      expect((error as McpError).code).toBe(ErrorCode.InvalidRequest);
    }
  });

  it('returns an MCP error to a client whose tools/call handler runs the guard before ready', async () => {
    // Surface this end-to-end: we want the actual client to see an MCP error
    // rather than the guard merely throwing inside our process. To exercise
    // the pre-init path through a transport, we need a Server that does NOT
    // flip ready on initialized — otherwise SDK.Client.connect() finishes
    // the lifecycle before we get a chance to send tools/call. So we install
    // our own oninitialized that holds ready=false, then invoke tools/call.
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const built = buildToolbxMcpServer({
      logger: createNoopLogger(),
      sessionId: 'pre-init',
      registerHandlers: (server, session) => {
        server.setRequestHandler(CallToolRequestSchema, () => {
          requireReady(session);
          return { content: [] };
        });
      },
    });
    // Suppress the lifecycle-driven ready flip so the guard fires.
    built.server.oninitialized = () => {};
    await built.server.connect(serverTransport);

    const client = new Client(
      { name: 'toolbx-lifecycle-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    await expect(client.callTool({ name: 'whatever', arguments: {} })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });

    await client.close();
    await built.server.close();
  });
});

describe('lifecycle handlers — ping', () => {
  it('round-trips ping over an in-memory transport', async () => {
    const { client, closeAll } = await connectPair();
    await expect(client.ping()).resolves.toBeDefined();
    await closeAll();
  });
});
