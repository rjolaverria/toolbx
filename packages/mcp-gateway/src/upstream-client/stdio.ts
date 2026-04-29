import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { Logger, StdioServerConfig } from '@toolbox/core';

import { resolveEnvPlaceholders } from './env.js';
import {
  UpstreamCallToolTimeoutError,
  UpstreamConnectError,
  UpstreamNotConnectedError,
} from './errors.js';
import type {
  CallToolResult,
  ListToolsResult,
  UpstreamClient,
  UpstreamClientEvent,
  UpstreamClientEvents,
  UpstreamCallToolOptions,
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

export interface CreateStdioUpstreamClientDeps {
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

export function createStdioUpstreamClient(
  config: StdioServerConfig,
  deps: CreateStdioUpstreamClientDeps,
): UpstreamClient {
  const serverName = deps.serverName;
  const baseLogger = serverName ? deps.logger.child({ server: serverName }) : deps.logger;
  const log = baseLogger.child({ component: 'upstream-stdio' });

  const handlers: { [K in UpstreamClientEvent]: Set<UpstreamClientEvents[K]> } = {
    tools_list_changed: new Set(),
    log: new Set(),
    exit: new Set(),
  };

  let state: 'idle' | 'connecting' | 'connected' | 'closing' | 'closed' = 'idle';
  let intentionalDisconnect = false;
  let exitEmitted = false;

  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

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

  async function connect(): Promise<void> {
    if (state === 'connected' || state === 'connecting') {
      throw new UpstreamConnectError(`Upstream client is already ${state}`, serverName);
    }
    state = 'connecting';
    intentionalDisconnect = false;
    exitEmitted = false;

    let resolvedEnv: Record<string, string> | undefined;
    try {
      resolvedEnv = resolveEnvPlaceholders({
        env: config.env,
        ...(deps.processEnv !== undefined ? { processEnv: deps.processEnv } : {}),
        ...(serverName !== undefined ? { serverName } : {}),
      });
    } catch (error) {
      state = 'closed';
      throw error;
    }

    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(resolvedEnv !== undefined ? { env: resolvedEnv } : {}),
      stderr: 'pipe',
    });

    client = new Client(TOOLBOX_CLIENT_INFO, { capabilities: {} });

    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      emit('tools_list_changed');
    });

    transport.onerror = (error) => {
      log.debug({ err: error }, 'upstream stdio transport error');
    };

    const connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    try {
      await client.connect(transport, { timeout: connectTimeoutMs });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to connect to upstream stdio server';
      try {
        await transport.close();
      } catch {
        // best effort
      }
      transport = null;
      client = null;
      state = 'closed';
      emitExitOnce();
      throw new UpstreamConnectError(
        `Failed to connect to upstream stdio server${serverName ? ` "${serverName}"` : ''}: ${message}`,
        serverName,
        { cause: error },
      );
    }

    const stderr = transport.stderr;
    if (stderr) {
      const lines = readline.createInterface({ input: stderr as unknown as Readable });
      lines.on('line', (line) => {
        if (line.length === 0) {
          return;
        }
        log.debug({ stream: 'stderr' }, line);
        emit('log', { level: 'debug', message: line });
      });
    }

    const previousOnClose = transport.onclose;
    transport.onclose = () => {
      previousOnClose?.();
      if (state !== 'closing') {
        log.debug('upstream stdio transport closed unexpectedly');
      }
      state = 'closed';
      client = null;
      transport = null;
      emitExitOnce();
    };

    state = 'connected';
  }

  async function disconnect(): Promise<void> {
    if (state === 'idle' || state === 'closed') {
      // Idempotent: already disconnected.
      return;
    }
    if (state === 'closing') {
      // A concurrent disconnect is in progress; let it run and return.
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
      log.debug({ err: error }, 'error during upstream stdio disconnect');
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
