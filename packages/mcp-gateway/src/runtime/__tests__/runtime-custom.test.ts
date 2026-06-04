import { createNoopLogger, type ServerConfig, type ToolBoxConfig } from '@toolbox/core';
import { describe, expect, it, vi } from 'vitest';

import type { CustomToolHost, CustomToolHostDeps } from '../custom-tools-host.js';
import { createGatewayRuntime } from '../runtime.js';

const STDIO_SERVER: ServerConfig = { type: 'stdio', enabled: true, command: 'fake', args: [] };

function makeConfig(servers: Record<string, ServerConfig> = {}): ToolBoxConfig {
  return {
    version: 1,
    server: {
      stdio: { enabled: true },
      http: { enabled: true, host: '127.0.0.1', port: 0, path: '/mcp' },
    },
    progressiveDisclosure: {
      enabled: false,
      mode: 'session',
      bootstrapTools: false,
      autoRevealExactServerMatches: false,
      maxSearchResults: 20,
    },
    namespacing: { separator: '__', format: 'server__tool', collisionStrategy: 'error' },
    auth: { storage: { type: 'keychain' } },
    servers,
    tools: {},
  };
}

const echoInput = {
  exposedName: 'personal__echo',
  namespace: 'personal',
  name: 'echo',
  tool: {
    name: 'personal__echo',
    title: 'Echo',
    description: 'Echoes input',
    inputSchema: { type: 'object' as const, properties: {} },
  },
};

/** Flush pending microtasks so the fire-and-forget custom-tool load resolves. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createGatewayRuntime — custom tools', () => {
  it('registers enabled custom tools into the registry after startUpstreams()', async () => {
    const host: CustomToolHost = {
      load: vi.fn(() => Promise.resolve([echoInput])),
      executor: { run: vi.fn() },
      manifestSnapshot: Promise.resolve([]),
    };
    const runtime = createGatewayRuntime({
      config: makeConfig(),
      logger: createNoopLogger(),
      configDir: '/cfg',
      createCustomToolHost: () => host,
    });

    expect(runtime.toolRegistry.find('personal__echo')).toBeUndefined();
    runtime.startUpstreams();
    await flush();

    const entry = runtime.toolRegistry.find('personal__echo');
    expect(entry).toMatchObject({ exposedName: 'personal__echo', source: 'custom' });
  });

  it('builds the host with the set of enabled server names for the collision guard', () => {
    let captured: CustomToolHostDeps | undefined;
    const createHost = (hostDeps: CustomToolHostDeps): CustomToolHost => {
      captured = hostDeps;
      return {
        load: vi.fn(() => Promise.resolve([])),
        executor: { run: vi.fn() },
        manifestSnapshot: Promise.resolve([]),
      };
    };
    createGatewayRuntime({
      config: makeConfig({ jira: STDIO_SERVER, off: { ...STDIO_SERVER, enabled: false } }),
      logger: createNoopLogger(),
      configDir: '/cfg',
      createCustomToolHost: createHost,
      createSession: (name) =>
        ({
          serverName: name,
          status: { kind: 'stopped' },
          start: () => Promise.resolve(),
          restart: () => Promise.resolve(),
          dispose: () => Promise.resolve(),
          cachedTools: () => undefined,
          listTools: () => Promise.resolve({ tools: [] }),
          callTool: () => Promise.resolve({ content: [] }),
          ping: () => Promise.resolve(),
          on: () => undefined,
          off: () => undefined,
        }) as never,
    });

    expect(captured).toBeDefined();
    expect([...captured!.enabledServerNames].sort()).toEqual(['jira']);
  });

  it('does not build a custom-tool host when no configDir is provided', () => {
    const createHost = vi.fn();
    const runtime = createGatewayRuntime({
      config: makeConfig(),
      logger: createNoopLogger(),
      createCustomToolHost: createHost,
    });
    runtime.startUpstreams();
    expect(createHost).not.toHaveBeenCalled();
  });
});
