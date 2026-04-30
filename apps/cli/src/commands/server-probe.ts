import { createNoopLogger, type ServerConfig } from '@toolbox/core';
import {
  createHttpUpstreamClient,
  createStdioUpstreamClient,
  UpstreamAuthRequiredError,
  UpstreamMissingEnvVarError,
  type ListToolsResult,
  type UpstreamClient,
} from '@toolbox/mcp-gateway';

import { withTimeout } from './server-shared.js';

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export type ProbeResult =
  | { kind: 'disabled' }
  | { kind: 'connected'; tools: ListToolsResult['tools']; connectedAt: Date }
  | { kind: 'auth_required'; reason: string }
  | { kind: 'error'; error: Error };

export interface ProbeServerOptions {
  /**
   * Total timeout (ms) for `connect → listTools`. Falls back to the server
   * config `timeoutMs`, then a small CLI default. Tests can override.
   */
  timeoutMs?: number;
  /** Process env override (used only by the http transport for header/auth). */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Test seam: replaces the upstream-client factory. When unset, the probe
   * uses the real stdio/http factories from `@toolbox/mcp-gateway`.
   */
  clientFactory?: ProbeClientFactory;
}

export interface ProbeClientFactoryArgs {
  name: string;
  config: ServerConfig;
  connectTimeoutMs: number;
  processEnv?: NodeJS.ProcessEnv;
}

export type ProbeClientFactory = (args: ProbeClientFactoryArgs) => UpstreamClient;

export type ProbeServerFn = (
  name: string,
  config: ServerConfig,
  options?: ProbeServerOptions,
) => Promise<ProbeResult>;

function defaultClientFactory(args: ProbeClientFactoryArgs): UpstreamClient {
  const { name, config, connectTimeoutMs, processEnv } = args;
  const logger = createNoopLogger();
  if (config.type === 'stdio') {
    return createStdioUpstreamClient(config, {
      logger,
      serverName: name,
      connectTimeoutMs,
      ...(processEnv !== undefined ? { processEnv } : {}),
    });
  }
  return createHttpUpstreamClient(config, {
    logger,
    serverName: name,
    connectTimeoutMs,
    ...(processEnv !== undefined ? { processEnv } : {}),
  });
}

export async function probeServer(
  name: string,
  config: ServerConfig,
  options: ProbeServerOptions = {},
): Promise<ProbeResult> {
  if (!config.enabled) {
    return { kind: 'disabled' };
  }

  const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const factory = options.clientFactory ?? defaultClientFactory;
  let client: UpstreamClient;
  try {
    client = factory({
      name,
      config,
      connectTimeoutMs: timeoutMs,
      ...(options.processEnv !== undefined ? { processEnv: options.processEnv } : {}),
    });
  } catch (error) {
    return classifyError(error);
  }

  let connectedAt: Date;
  try {
    await client.connect();
    connectedAt = new Date();
  } catch (error) {
    return classifyError(error);
  }

  try {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      return { kind: 'error', error: new Error(`probe timed out after ${timeoutMs}ms`) };
    }
    const result = await withTimeout(client.listTools(), remaining, 'listTools');
    return { kind: 'connected', tools: result.tools, connectedAt };
  } catch (error) {
    return classifyError(error);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

function classifyError(error: unknown): ProbeResult {
  if (error instanceof UpstreamAuthRequiredError) {
    return { kind: 'auth_required', reason: error.message };
  }
  if (error instanceof UpstreamMissingEnvVarError) {
    return { kind: 'auth_required', reason: error.message };
  }
  if (error instanceof Error) {
    return { kind: 'error', error };
  }
  return { kind: 'error', error: new Error(String(error)) };
}
