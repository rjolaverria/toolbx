import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  createStatusRegistry,
  type ServerConfig,
  type StatusRegistry,
  type ToolBoxConfig,
} from '@rjolaverria/toolbox-core';
import { describe, expect, it } from 'vitest';

import { LIST_AVAILABLE_SERVERS_NAME } from '../names.js';
import { createListAvailableServersBootstrap } from '../list-available-servers.js';

interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

interface ServersListLine {
  readonly kind: 'available-servers';
  readonly servers: readonly ServerSummary[];
  readonly returned: number;
  readonly total: number;
  readonly includeDisabled: boolean;
}

interface ServerSummary {
  readonly name: string;
  readonly type: 'stdio' | 'http';
  readonly enabled: boolean;
  readonly status: { readonly kind: string; readonly [k: string]: unknown };
  readonly toolCount: number;
}

const baseConfig: Omit<ToolBoxConfig, 'servers'> = {
  $schema: 'https://toolbox.dev/schema/config.schema.json',
  version: 1,
  server: {
    stdio: { enabled: true },
    http: { enabled: true, host: '127.0.0.1', port: 7331, path: '/mcp' },
  },
  progressiveDisclosure: {
    enabled: true,
    mode: 'session',
    bootstrapTools: true,
    autoRevealExactServerMatches: true,
    maxSearchResults: 20,
  },
  namespacing: {
    separator: '__',
    format: 'server__tool',
    collisionStrategy: 'error',
  },
  auth: {
    storage: { type: 'keychain' },
  },
  tools: {},
  customTools: { sandbox: { mode: 'auto', require: false } },
};

const stdioEnabled: ServerConfig = {
  type: 'stdio',
  enabled: true,
  command: 'node',
  args: [],
};
const stdioDisabled: ServerConfig = {
  type: 'stdio',
  enabled: false,
  command: 'node',
  args: [],
};
const httpEnabled: ServerConfig = {
  type: 'http',
  enabled: true,
  url: 'https://api.example.com/mcp',
};

function registryWith(servers: Record<string, ServerConfig>): StatusRegistry {
  return createStatusRegistry({ ...baseConfig, servers });
}

function parseLine(result: CallToolResult): ServersListLine {
  const blocks = result.content as TextBlock[];
  expect(blocks).toHaveLength(1);
  const first = blocks[0];
  expect(first).toBeDefined();
  return JSON.parse(first!.text) as ServersListLine;
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const blocks = result.content as TextBlock[];
  expect(blocks).toHaveLength(1);
  return blocks[0]!.text;
}

describe('toolbox__list_available_servers (M4-05)', () => {
  it('exposes the canonical descriptor', () => {
    const tool = createListAvailableServersBootstrap({
      statusRegistry: registryWith({}),
    });
    expect(tool.descriptor.name).toBe(LIST_AVAILABLE_SERVERS_NAME);
    expect(tool.descriptor.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        includeDisabled: { type: 'boolean' },
      },
      required: [],
      additionalProperties: false,
    });
  });

  it('returns one entry per enabled server with its transport, status, and tool count', async () => {
    const statusRegistry = registryWith({
      alpha: stdioEnabled,
      gamma: httpEnabled,
    });
    const tool = createListAvailableServersBootstrap({ statusRegistry });

    const result = await tool.invoke({});

    expect(result.isError).toBeUndefined();
    const line = parseLine(result);
    expect(line.kind).toBe('available-servers');
    expect(line.includeDisabled).toBe(false);
    expect(line.returned).toBe(2);
    expect(line.total).toBe(2);
    expect(line.servers).toEqual([
      {
        name: 'alpha',
        type: 'stdio',
        enabled: true,
        status: { kind: 'stopped' },
        toolCount: 0,
      },
      {
        name: 'gamma',
        type: 'http',
        enabled: true,
        status: { kind: 'stopped' },
        toolCount: 0,
      },
    ]);
  });

  it('skips disabled servers by default', async () => {
    const statusRegistry = registryWith({
      alpha: stdioEnabled,
      beta: stdioDisabled,
    });
    const tool = createListAvailableServersBootstrap({ statusRegistry });

    const line = parseLine(await tool.invoke({}));
    expect(line.servers.map((s) => s.name)).toEqual(['alpha']);
    expect(line.returned).toBe(1);
    expect(line.total).toBe(2);
  });

  it('includes disabled servers when includeDisabled is true', async () => {
    const statusRegistry = registryWith({
      alpha: stdioEnabled,
      beta: stdioDisabled,
    });
    const tool = createListAvailableServersBootstrap({ statusRegistry });

    const line = parseLine(await tool.invoke({ includeDisabled: true }));
    expect(line.includeDisabled).toBe(true);
    expect(line.servers.map((s) => s.name)).toEqual(['alpha', 'beta']);
    const beta = line.servers.find((s) => s.name === 'beta');
    expect(beta).toEqual({
      name: 'beta',
      type: 'stdio',
      enabled: false,
      status: { kind: 'disabled' },
      toolCount: 0,
    });
  });

  it('reflects live status updates from the M1-04 registry', async () => {
    const statusRegistry = registryWith({ alpha: stdioEnabled });
    const tool = createListAvailableServersBootstrap({ statusRegistry });

    statusRegistry.update('alpha', { status: { kind: 'starting', attempt: 1 } });
    let line = parseLine(await tool.invoke({}));
    expect(line.servers[0]?.status).toEqual({ kind: 'starting', attempt: 1 });

    const since = new Date('2026-04-01T12:00:00Z');
    statusRegistry.update('alpha', { status: { kind: 'connected', since }, toolCount: 5 });
    line = parseLine(await tool.invoke({}));
    expect(line.servers[0]?.status).toEqual({
      kind: 'connected',
      since: since.toISOString(),
    });
    expect(line.servers[0]?.toolCount).toBe(5);
  });

  it('serializes auth_required and auth_expired statuses with their reasons', async () => {
    const statusRegistry = registryWith({ alpha: stdioEnabled });
    const tool = createListAvailableServersBootstrap({ statusRegistry });

    statusRegistry.update('alpha', { status: { kind: 'starting', attempt: 1 } });
    statusRegistry.update('alpha', {
      status: { kind: 'auth_required', reason: 'missing token' },
    });
    let line = parseLine(await tool.invoke({}));
    expect(line.servers[0]?.status).toEqual({
      kind: 'auth_required',
      reason: 'missing token',
    });

    statusRegistry.update('alpha', { status: { kind: 'starting', attempt: 2 } });
    statusRegistry.update('alpha', {
      status: { kind: 'auth_expired', reason: 'expired token' },
    });
    line = parseLine(await tool.invoke({}));
    expect(line.servers[0]?.status).toEqual({
      kind: 'auth_expired',
      reason: 'expired token',
    });
  });

  it('serializes error status with message and ISO retry timestamp', async () => {
    const statusRegistry = registryWith({ alpha: stdioEnabled });
    const tool = createListAvailableServersBootstrap({ statusRegistry });

    statusRegistry.update('alpha', { status: { kind: 'starting', attempt: 1 } });
    const nextRetryAt = new Date('2026-04-02T08:00:00Z');
    statusRegistry.update('alpha', {
      status: {
        kind: 'error',
        error: new Error('connection refused'),
        nextRetryAt,
      },
    });

    const line = parseLine(await tool.invoke({}));
    expect(line.servers[0]?.status).toEqual({
      kind: 'error',
      error: 'connection refused',
      nextRetryAt: nextRetryAt.toISOString(),
    });
  });

  it('serializes error status with null nextRetryAt', async () => {
    const statusRegistry = registryWith({ alpha: stdioEnabled });
    const tool = createListAvailableServersBootstrap({ statusRegistry });

    statusRegistry.update('alpha', { status: { kind: 'starting', attempt: 1 } });
    statusRegistry.update('alpha', {
      status: {
        kind: 'error',
        error: new Error('boom'),
        nextRetryAt: null,
      },
    });

    const line = parseLine(await tool.invoke({}));
    expect(line.servers[0]?.status).toEqual({
      kind: 'error',
      error: 'boom',
      nextRetryAt: null,
    });
  });

  it('does not mutate the status registry on invocation', async () => {
    const statusRegistry = registryWith({
      alpha: stdioEnabled,
      beta: stdioDisabled,
    });
    const tool = createListAvailableServersBootstrap({ statusRegistry });

    const before = statusRegistry.list();
    await tool.invoke({});
    await tool.invoke({ includeDisabled: true });
    const after = statusRegistry.list();
    expect(after).toEqual(before);
  });

  it('returns an empty list when no servers are configured', async () => {
    const tool = createListAvailableServersBootstrap({ statusRegistry: registryWith({}) });
    const line = parseLine(await tool.invoke({}));
    expect(line.servers).toEqual([]);
    expect(line.returned).toBe(0);
    expect(line.total).toBe(0);
  });

  it('sorts servers by byte order, not localeCompare', async () => {
    // Byte-order sorts uppercase ASCII before lowercase (`B` < `a`).
    // `localeCompare` may treat them case-insensitively (or per-locale),
    // which would put `alpha` before `Beta`. Pin byte order so the API
    // output is identical across runtimes and locales.
    const statusRegistry = registryWith({
      Beta: stdioEnabled,
      alpha: stdioEnabled,
    });
    const tool = createListAvailableServersBootstrap({ statusRegistry });

    const line = parseLine(await tool.invoke({}));
    expect(line.servers.map((s) => s.name)).toEqual(['Beta', 'alpha']);
  });

  it('treats omitted args as the default (empty object)', async () => {
    const statusRegistry = registryWith({ alpha: stdioEnabled });
    const tool = createListAvailableServersBootstrap({ statusRegistry });
    const line = parseLine(await tool.invoke(undefined));
    expect(line.includeDisabled).toBe(false);
    expect(line.servers).toHaveLength(1);
  });

  it('rejects non-boolean includeDisabled', async () => {
    const tool = createListAvailableServersBootstrap({
      statusRegistry: registryWith({ alpha: stdioEnabled }),
    });
    const text = errorText(await tool.invoke({ includeDisabled: 'yes' }));
    expect(text).toContain(`invalid arguments to ${LIST_AVAILABLE_SERVERS_NAME}`);
    expect(text).toContain('includeDisabled');
  });

  it('rejects extra top-level properties', async () => {
    const tool = createListAvailableServersBootstrap({
      statusRegistry: registryWith({ alpha: stdioEnabled }),
    });
    const text = errorText(await tool.invoke({ extra: true }));
    expect(text).toContain(`invalid arguments to ${LIST_AVAILABLE_SERVERS_NAME}`);
  });
});
