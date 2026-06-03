import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createNoopLogger, type Logger, type ToolBoxConfig, type TokenStore } from '@toolbox/core';

import { createDownstreamHttpServer } from '../../../downstream-server/http.js';
import type { DownstreamHttpServer } from '../../../downstream-server/types.js';
import { createGatewayRuntime, type GatewayRuntime } from '../../runtime.js';

export const ECHO_FIXTURE = fileURLToPath(
  new URL('../../../upstream-client/__tests__/__fixtures__/echo-server.mjs', import.meta.url),
);

export const CRASHABLE_FIXTURE = fileURLToPath(new URL('./crashable-server.mjs', import.meta.url));

export const COLLIDING_FIXTURE = fileURLToPath(new URL('./colliding-server.mjs', import.meta.url));

export interface IntegrationHarness {
  readonly clients: Set<Client>;
  readonly servers: Set<DownstreamHttpServer>;
  readonly runtimes: Set<GatewayRuntime>;
  /** Tear down every tracked client / server / runtime, in order. */
  cleanup(): Promise<void>;
}

/**
 * Returns the bookkeeping sets the integration tests use to clean up between
 * cases. Each test creates a harness, registers the clients / downstream
 * servers / runtimes it spins up, and calls `cleanup()` in `afterEach`.
 *
 * Tests must register every long-lived resource here. The cleanup order
 * mirrors the real shutdown path: clients first (so in-flight requests fail
 * loudly rather than the transport hanging on a half-closed connection),
 * then the downstream server (drains the HTTP listener), then the runtime
 * (disposes upstream sessions).
 */
export function createIntegrationHarness(): IntegrationHarness {
  const clients = new Set<Client>();
  const servers = new Set<DownstreamHttpServer>();
  const runtimes = new Set<GatewayRuntime>();

  return {
    clients,
    servers,
    runtimes,
    async cleanup() {
      for (const client of clients) {
        await client.close().catch(() => undefined);
      }
      clients.clear();
      for (const server of servers) {
        await server.stop().catch(() => undefined);
      }
      servers.clear();
      for (const runtime of runtimes) {
        await runtime.dispose().catch(() => undefined);
      }
      runtimes.clear();
    },
  };
}

export interface MakeConfigOptions {
  servers?: ToolBoxConfig['servers'];
  progressiveDisclosure?: Partial<ToolBoxConfig['progressiveDisclosure']>;
  tools?: ToolBoxConfig['tools'];
}

/**
 * Builds a Phase-1 valid `ToolBoxConfig` with the echo-server stdio upstream
 * already wired up. Tests pass overrides for the bits they actually care
 * about (the `servers` map, disclosure tweaks, per-tool overrides).
 */
export function makeIntegrationConfig(options: MakeConfigOptions = {}): ToolBoxConfig {
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
      ...options.progressiveDisclosure,
    },
    namespacing: { separator: '__', format: 'server__tool', collisionStrategy: 'error' },
    auth: { storage: { type: 'keychain' } },
    servers: options.servers ?? {
      echo: {
        type: 'stdio',
        enabled: true,
        command: process.execPath,
        args: [ECHO_FIXTURE],
      },
    },
    tools: options.tools ?? {},
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface StartHarnessOptions {
  config: ToolBoxConfig;
  harness: IntegrationHarness;
  logger?: Logger;
  processEnv?: NodeJS.ProcessEnv;
  /** Token store for OAuth upstreams. Forwarded to the gateway runtime. */
  tokenStore?: TokenStore;
  /**
   * Names of upstream servers to wait for in `connected` status before the
   * helper returns. Defaults to every enabled server in the config.
   */
  waitForServers?: readonly string[];
  waitTimeoutMs?: number;
  /**
   * ToolBox config directory. When set, the runtime exposes imported, enabled
   * custom tools from `<configDir>/tools/manifest.json` (P3-05).
   */
  configDir?: string;
}

export interface StartedHarness {
  readonly runtime: GatewayRuntime;
  readonly downstream: DownstreamHttpServer;
}

/**
 * Starts a gateway runtime with the supplied config and binds a downstream
 * HTTP server on a free port, then waits until the named upstream sessions
 * report `connected`. Returns the runtime + downstream so the caller can
 * drive assertions, or pass the URL to a new `Client`. Both handles are
 * registered with the harness for `afterEach` cleanup.
 */
export async function startHarness(options: StartHarnessOptions): Promise<StartedHarness> {
  const logger = options.logger ?? createNoopLogger();
  const runtime = createGatewayRuntime({
    config: options.config,
    logger,
    ...(options.processEnv !== undefined ? { processEnv: options.processEnv } : {}),
    ...(options.tokenStore !== undefined ? { tokenStore: options.tokenStore } : {}),
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
  });
  options.harness.runtimes.add(runtime);
  runtime.startUpstreams();

  const downstream = createDownstreamHttpServer({
    logger,
    http: { host: '127.0.0.1', port: 0, path: '/mcp' },
    registerHandlers: runtime.registerHandlers,
  });
  options.harness.servers.add(downstream);
  await downstream.start();

  const targets =
    options.waitForServers ??
    Object.entries(options.config.servers)
      .filter(([, server]) => server.enabled)
      .map(([name]) => name);
  const timeoutMs = options.waitTimeoutMs ?? 5000;
  for (const name of targets) {
    await waitFor(() => runtime.statusRegistry.get(name)?.status.kind === 'connected', timeoutMs);
  }

  return { runtime, downstream };
}

/** Convenience: connect an MCP `Client` over `StreamableHTTPClientTransport` to the supplied URL. */
export async function connectHttpClient(
  url: URL,
  name: string,
  harness: IntegrationHarness,
): Promise<Client> {
  const client = new Client({ name, version: '0.0.0' }, { capabilities: {} });
  harness.clients.add(client);
  await client.connect(new StreamableHTTPClientTransport(url) as Transport);
  return client;
}
