import { describe, expect, it, vi } from 'vitest';

import { CONTROL_PLANE_HEADER, CONTROL_PLANE_MARKER } from '../../serve-daemon/control-plane.js';
import {
  connectDaemonClient,
  type ConnectDaemonClientDeps,
  type DaemonMcpClient,
} from '../client.js';

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeDeps(): {
  deps: ConnectDaemonClientDeps;
  transports: { url: URL; headers: Record<string, string> }[];
  client: FakeClient;
} {
  const transports: { url: URL; headers: Record<string, string> }[] = [];
  const transportToken = { kind: 'fake-transport' };
  const client: FakeClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const deps: ConnectDaemonClientDeps = {
    buildTransport: (url, headers) => {
      transports.push({ url, headers });
      return transportToken;
    },
    buildClient: () => client as unknown as DaemonMcpClient,
  };
  return { deps, transports, client };
}

describe('connectDaemonClient', () => {
  it('connects with the control-plane marker header on the daemon URL', async () => {
    const { deps, transports, client } = makeDeps();

    await connectDaemonClient('http://127.0.0.1:7393/mcp', deps);

    expect(transports).toHaveLength(1);
    expect(transports[0]?.url.toString()).toBe('http://127.0.0.1:7393/mcp');
    expect(transports[0]?.headers[CONTROL_PLANE_HEADER]).toBe(CONTROL_PLANE_MARKER);
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it('delegates listTools and callTool to the underlying client', async () => {
    const { deps, client } = makeDeps();
    client.listTools.mockResolvedValue({ tools: [{ name: 'github__create_issue' }] });
    client.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const daemon = await connectDaemonClient('http://127.0.0.1:7393/mcp', deps);

    await expect(daemon.listTools()).resolves.toEqual({
      tools: [{ name: 'github__create_issue' }],
    });

    const result = await daemon.callTool({
      name: 'github__create_issue',
      arguments: { title: 'Bug' },
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: 'github__create_issue',
      arguments: { title: 'Bug' },
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('closes the transport even when connect failed', async () => {
    const { deps, client } = makeDeps();
    client.connect.mockRejectedValue(new Error('boom'));

    await expect(connectDaemonClient('http://127.0.0.1:7393/mcp', deps)).rejects.toThrow('boom');
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('closes the underlying client on close()', async () => {
    const { deps, client } = makeDeps();

    const daemon = await connectDaemonClient('http://127.0.0.1:7393/mcp', deps);
    await daemon.close();

    expect(client.close).toHaveBeenCalledOnce();
  });
});
