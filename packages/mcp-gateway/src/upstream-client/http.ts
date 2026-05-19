import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { HttpServerConfig, Logger } from '@toolbox/core';

import { resolveEnvPlaceholders } from './env.js';
import {
  UpstreamAuthRequiredError,
  UpstreamCallToolTimeoutError,
  UpstreamConnectError,
  UpstreamNotConnectedError,
} from './errors.js';
import type {
  CallToolResult,
  ListToolsResult,
  UpstreamCallToolOptions,
  UpstreamClient,
  UpstreamClientEvent,
  UpstreamClientEvents,
} from './types.js';

const TOOLBOX_CLIENT_INFO = {
  name: 'toolbox-upstream-client',
  version: '0.0.0',
} as const;

const DEFAULT_CALL_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

const REQUEST_TIMEOUT_ERROR_CODE: number = ErrorCode.RequestTimeout;
function isRequestTimeoutCode(code: number): boolean {
  return code === REQUEST_TIMEOUT_ERROR_CODE;
}

export interface CreateHttpUpstreamClientDeps {
  logger: Logger;
  /** Optional override for the process env used when resolving `${env:VAR}` placeholders. */
  processEnv?: NodeJS.ProcessEnv;
  /** Optional human-readable name of the upstream server, used in error messages and log bindings. */
  serverName?: string;
  /**
   * Maximum time to wait for the upstream server to respond to the `initialize`
   * request before failing `connect()`. Defaults to 30 seconds.
   */
  connectTimeoutMs?: number;
}

export function createHttpUpstreamClient(
  config: HttpServerConfig,
  deps: CreateHttpUpstreamClientDeps,
): UpstreamClient {
  const serverName = deps.serverName;
  const baseLogger = serverName ? deps.logger.child({ server: serverName }) : deps.logger;
  const log = baseLogger.child({ component: 'upstream-http' });
  const processEnv = deps.processEnv ?? process.env;

  const handlers: { [K in UpstreamClientEvent]: Set<UpstreamClientEvents[K]> } = {
    tools_list_changed: new Set(),
    log: new Set(),
    exit: new Set(),
  };

  let state: 'idle' | 'connecting' | 'connected' | 'closing' | 'closed' = 'idle';
  let intentionalDisconnect = false;
  let exitEmitted = false;

  let client: Client | null = null;
  let transport: StreamableHTTPClientTransport | null = null;

  function emit<E extends UpstreamClientEvent>(
    event: E,
    ...args: Parameters<UpstreamClientEvents[E]>
  ): void {
    for (const handler of handlers[event]) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch (error) {
        log.warn({ err: error, event }, 'upstream-client event handler threw');
      }
    }
  }

  function emitExitOnce(): void {
    if (exitEmitted) {
      return;
    }
    exitEmitted = true;
    emit('exit', { intentional: intentionalDisconnect });
  }

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.headers !== undefined) {
      const resolved = resolveEnvPlaceholders({
        env: config.headers,
        processEnv,
        ...(serverName !== undefined ? { serverName } : {}),
      });
      if (resolved !== undefined) {
        Object.assign(headers, resolved);
      }
    }
    if (config.auth?.type === 'bearer') {
      const token = processEnv[config.auth.tokenEnv];
      if (token === undefined || token.length === 0) {
        throw new UpstreamAuthRequiredError(config.auth.tokenEnv, serverName);
      }
      headers['Authorization'] = `Bearer ${token}`;
    } else if (config.auth?.type === 'oauth') {
      // OAuth header injection is wired up in F1-21 (gateway side); fail
      // loudly here instead of silently connecting without an Authorization
      // header, which would surface as a confusing 401 from the upstream.
      throw new Error('auth.type "oauth" not yet implemented (F1-21)');
    }
    return headers;
  }

  async function connect(): Promise<void> {
    if (state !== 'idle' && state !== 'closed') {
      throw new UpstreamConnectError(`Upstream client is already ${state}`, serverName);
    }
    state = 'connecting';
    intentionalDisconnect = false;
    exitEmitted = false;

    let headers: Record<string, string>;
    try {
      headers = buildHeaders();
    } catch (error) {
      state = 'closed';
      throw error;
    }

    let url: URL;
    try {
      url = new URL(config.url);
    } catch (error) {
      state = 'closed';
      throw new UpstreamConnectError(
        `Invalid upstream URL${serverName ? ` for "${serverName}"` : ''}: ${config.url}`,
        serverName,
        { cause: error },
      );
    }

    // Hold the transport/client in locals across the `await` boundary so a
    // concurrent disconnect() — which only nulls the shared slots — cannot race
    // us into a TypeError. We only promote the locals into the shared slots
    // after a successful connect, and only if the state machine still says
    // we're connecting.
    const localTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });

    const localClient = new Client(TOOLBOX_CLIENT_INFO, { capabilities: {} });

    localClient.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      emit('tools_list_changed');
    });

    localTransport.onerror = (error) => {
      log.debug({ err: error }, 'upstream http transport error');
    };

    const connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    // The SDK's `Transport.sessionId` is declared as `sessionId?: string`,
    // which under `exactOptionalPropertyTypes` rejects the `string | undefined`
    // returned by `StreamableHTTPClientTransport`'s getter. The values are
    // structurally compatible — this cast just silences the strictness mismatch.
    const transportArg = localTransport as Parameters<Client['connect']>[0];
    try {
      await localClient.connect(transportArg, { timeout: connectTimeoutMs });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to connect to upstream HTTP server';
      try {
        await localTransport.close();
      } catch {
        // best effort
      }
      if (state === 'connecting') {
        state = 'closed';
      }
      emitExitOnce();
      throw new UpstreamConnectError(
        `Failed to connect to upstream HTTP server${serverName ? ` "${serverName}"` : ''}: ${message}`,
        serverName,
        { cause: error },
      );
    }

    if (state !== 'connecting') {
      try {
        await localClient.close();
      } catch {
        // best effort
      }
      emitExitOnce();
      throw new UpstreamConnectError(
        `Upstream client was disconnected during connect${serverName ? ` to "${serverName}"` : ''}`,
        serverName,
      );
    }

    const previousOnClose = localTransport.onclose;
    localTransport.onclose = () => {
      previousOnClose?.();
      if (state !== 'closing') {
        log.debug('upstream http transport closed unexpectedly');
      }
      state = 'closed';
      if (client === localClient) {
        client = null;
      }
      if (transport === localTransport) {
        transport = null;
      }
      emitExitOnce();
    };

    transport = localTransport;
    client = localClient;
    state = 'connected';
  }

  async function disconnect(): Promise<void> {
    if (state === 'idle' || state === 'closed') {
      return;
    }
    if (state === 'closing') {
      return;
    }
    state = 'closing';
    intentionalDisconnect = true;
    const t = transport;
    const c = client;
    transport = null;
    client = null;
    try {
      if (c) {
        await c.close();
      } else if (t) {
        await t.close();
      }
    } catch (error) {
      log.debug({ err: error }, 'error during upstream http disconnect');
    }
    state = 'closed';
    emitExitOnce();
  }

  function requireClient(): Client {
    if (state !== 'connected' || client === null) {
      throw new UpstreamNotConnectedError(serverName);
    }
    return client;
  }

  async function listTools(): Promise<ListToolsResult> {
    const c = requireClient();
    return c.listTools();
  }

  async function callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    opts: UpstreamCallToolOptions = {},
  ): Promise<CallToolResult> {
    const c = requireClient();
    const timeoutMs = opts.timeoutMs ?? config.timeoutMs ?? DEFAULT_CALL_TOOL_TIMEOUT_MS;
    try {
      return await c.callTool(
        { name, ...(args !== undefined ? { arguments: args } : {}) },
        undefined,
        {
          timeout: timeoutMs,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        },
      );
    } catch (error) {
      if (error instanceof McpError && isRequestTimeoutCode(error.code)) {
        throw new UpstreamCallToolTimeoutError(name, timeoutMs, serverName, { cause: error });
      }
      throw error;
    }
  }

  async function ping(): Promise<void> {
    const c = requireClient();
    await c.ping();
  }

  function on<E extends UpstreamClientEvent>(event: E, handler: UpstreamClientEvents[E]): void {
    handlers[event].add(handler);
  }

  function off<E extends UpstreamClientEvent>(event: E, handler: UpstreamClientEvents[E]): void {
    handlers[event].delete(handler);
  }

  return {
    serverName,
    connect,
    disconnect,
    listTools,
    callTool,
    ping,
    on,
    off,
  };
}
