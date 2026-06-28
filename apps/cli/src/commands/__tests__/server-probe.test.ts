import { describe, expect, it } from 'vitest';

import type { UpstreamClient } from '@toolbx/mcp-gateway';

import { probeServer, type ProbeClientFactory } from '../server-probe.js';

interface FakeClientOptions {
  /** Resolves listTools after this many ms. If absent, listTools never settles. */
  listToolsAfterMs?: number;
  /** Tools to return when listTools resolves. */
  tools?: Array<{ name: string }>;
}

function fakeClient(options: FakeClientOptions): UpstreamClient {
  return {
    serverName: undefined,
    connect: async () => Promise.resolve(),
    disconnect: async () => Promise.resolve(),
    listTools: () =>
      new Promise((resolve) => {
        if (options.listToolsAfterMs !== undefined) {
          setTimeout(() => {
            resolve({ tools: options.tools ?? [] });
          }, options.listToolsAfterMs);
        }
      }),
    callTool: async () => Promise.resolve({ content: [] }),
    ping: async () => Promise.resolve(),
    on: () => undefined,
    off: () => undefined,
  } as unknown as UpstreamClient;
}

function fixedFactory(client: UpstreamClient): ProbeClientFactory {
  return () => client;
}

describe('probeServer', () => {
  it('short-circuits to disabled without spawning a client', async () => {
    const result = await probeServer('github', {
      type: 'stdio',
      enabled: false,
      command: 'true',
      args: [],
    });

    expect(result).toEqual({ kind: 'disabled' });
  });

  it('returns connected with the discovered tools when listTools resolves in time', async () => {
    const client = fakeClient({ listToolsAfterMs: 0, tools: [{ name: 'a' }, { name: 'b' }] });
    const result = await probeServer(
      'github',
      { type: 'stdio', enabled: true, command: 'true', args: [] },
      { timeoutMs: 1000, clientFactory: fixedFactory(client) },
    );

    expect(result.kind).toBe('connected');
    if (result.kind === 'connected') {
      expect(result.tools).toHaveLength(2);
    }
  });

  it('captures connectedAt at connect time, not after listTools', async () => {
    const listToolsAfterMs = 30;
    const client = fakeClient({ listToolsAfterMs, tools: [{ name: 'a' }] });
    const before = Date.now();
    const result = await probeServer(
      'github',
      { type: 'stdio', enabled: true, command: 'true', args: [] },
      { timeoutMs: 1000, clientFactory: fixedFactory(client) },
    );
    const after = Date.now();

    expect(result.kind).toBe('connected');
    if (result.kind === 'connected') {
      const connectedAtMs = result.connectedAt.getTime();
      // connectedAt must precede the listTools resolution by at least most of
      // its delay — i.e. it represents connect time, not probe-finish time.
      expect(connectedAtMs).toBeGreaterThanOrEqual(before);
      expect(connectedAtMs).toBeLessThan(after - listToolsAfterMs / 2);
    }
  });

  it('enforces the timeout for the listTools phase', async () => {
    const stalled = fakeClient({});
    const result = await probeServer(
      'github',
      { type: 'stdio', enabled: true, command: 'true', args: [] },
      { timeoutMs: 25, clientFactory: fixedFactory(stalled) },
    );

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.message).toMatch(/listTools timed out/);
    }
  });
});
