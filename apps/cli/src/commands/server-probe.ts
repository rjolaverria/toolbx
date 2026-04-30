import { createNoopLogger, type ServerConfig } from '@toolbox/core';
import {
  createHttpUpstreamClient,
  createStdioUpstreamClient,
  UpstreamAuthRequiredError,
  UpstreamMissingEnvVarError,
  type ListToolsResult,
  type UpstreamClient,
} from '@toolbox/mcp-gateway';

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
}

export type ProbeServerFn = (
  name: string,
  config: ServerConfig,
  options?: ProbeServerOptions,
) => Promise<ProbeResult>;

function clientFor(
  name: string,
  config: ServerConfig,
  options: ProbeServerOptions,
  connectTimeoutMs: number,
): UpstreamClient {
  const logger = createNoopLogger();
  if (config.type === 'stdio') {
    return createStdioUpstreamClient(config, {
      logger,
      serverName: name,
      connectTimeoutMs,
      ...(options.processEnv !== undefined ? { processEnv: options.processEnv } : {}),
    });
  }
  return createHttpUpstreamClient(config, {
    logger,
    serverName: name,
    connectTimeoutMs,
    ...(options.processEnv !== undefined ? { processEnv: options.processEnv } : {}),
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
  let client: UpstreamClient;
  try {
    client = clientFor(name, config, options, timeoutMs);
  } catch (error) {
    return classifyError(error);
  }

  try {
    await client.connect();
  } catch (error) {
    return classifyError(error);
  }

  try {
    const result = await client.listTools();
    return { kind: 'connected', tools: result.tools, connectedAt: new Date() };
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
