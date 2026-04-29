import type { Logger, ServerConfig, ServerStatus } from '@toolbox/core';

import { UpstreamAuthRequiredError, UpstreamNotConnectedError } from './errors.js';
import { createHttpUpstreamClient } from './http.js';
import { createStdioUpstreamClient } from './stdio.js';
import type {
  CallToolResult,
  ListToolsResult,
  UpstreamCallToolOptions,
  UpstreamClient,
} from './types.js';

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_BACKOFF_INITIAL_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_BACKOFF_FACTOR = 2;

export interface UpstreamSessionBackoff {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export interface UpstreamSessionScheduler {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => Date;
}

export type UpstreamClientFactory = (
  config: ServerConfig,
  deps: {
    logger: Logger;
    serverName?: string | undefined;
    processEnv?: NodeJS.ProcessEnv | undefined;
    connectTimeoutMs?: number | undefined;
  },
) => UpstreamClient;

export interface CreateUpstreamSessionDeps {
  logger: Logger;
  serverName?: string;
  processEnv?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
  pingIntervalMs?: number;
  backoff?: Partial<UpstreamSessionBackoff>;
  /** Test seam: override how the underlying transport client is built. */
  createClient?: UpstreamClientFactory;
  /** Test seam: override timers and clock. Defaults to `globalThis`. */
  scheduler?: UpstreamSessionScheduler;
}

export interface UpstreamSessionEvents {
  status: (status: ServerStatus) => void;
  tools_list_changed: () => void;
}

export type UpstreamSessionEvent = keyof UpstreamSessionEvents;

export interface UpstreamSession {
  readonly serverName: string | undefined;
  readonly status: ServerStatus;
  start(): Promise<void>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
  cachedTools(): ListToolsResult | undefined;
  listTools(): Promise<ListToolsResult>;
  callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    opts?: UpstreamCallToolOptions,
  ): Promise<CallToolResult>;
  ping(): Promise<void>;
  on<E extends UpstreamSessionEvent>(event: E, handler: UpstreamSessionEvents[E]): void;
  off<E extends UpstreamSessionEvent>(event: E, handler: UpstreamSessionEvents[E]): void;
}

const defaultScheduler: UpstreamSessionScheduler = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  },
  now: () => new Date(),
};

const defaultCreateClient: UpstreamClientFactory = (config, deps) => {
  if (config.type === 'stdio') {
    return createStdioUpstreamClient(config, {
      logger: deps.logger,
      ...(deps.serverName !== undefined ? { serverName: deps.serverName } : {}),
      ...(deps.processEnv !== undefined ? { processEnv: deps.processEnv } : {}),
      ...(deps.connectTimeoutMs !== undefined ? { connectTimeoutMs: deps.connectTimeoutMs } : {}),
    });
  }
  return createHttpUpstreamClient(config, {
    logger: deps.logger,
    ...(deps.serverName !== undefined ? { serverName: deps.serverName } : {}),
    ...(deps.processEnv !== undefined ? { processEnv: deps.processEnv } : {}),
    ...(deps.connectTimeoutMs !== undefined ? { connectTimeoutMs: deps.connectTimeoutMs } : {}),
  });
};

function isAuthRequiredError(error: unknown): error is UpstreamAuthRequiredError {
  return error instanceof UpstreamAuthRequiredError;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function createUpstreamSession(
  config: ServerConfig,
  deps: CreateUpstreamSessionDeps,
): UpstreamSession {
  const serverName = deps.serverName;
  const baseLogger = serverName ? deps.logger.child({ server: serverName }) : deps.logger;
  const log = baseLogger.child({ component: 'upstream-session' });

  const scheduler = deps.scheduler ?? defaultScheduler;
  const createClient = deps.createClient ?? defaultCreateClient;
  const pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const backoff: UpstreamSessionBackoff = {
    initialMs: deps.backoff?.initialMs ?? DEFAULT_BACKOFF_INITIAL_MS,
    maxMs: deps.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS,
    factor: deps.backoff?.factor ?? DEFAULT_BACKOFF_FACTOR,
  };

  const handlers: { [K in UpstreamSessionEvent]: Set<UpstreamSessionEvents[K]> } = {
    status: new Set(),
    tools_list_changed: new Set(),
  };

  type Phase =
    | { kind: 'idle' }
    | { kind: 'starting'; attempt: number; client: UpstreamClient | null }
    | { kind: 'connected'; client: UpstreamClient }
    | { kind: 'waiting'; attempt: number; retryHandle: unknown }
    | { kind: 'auth_required' }
    | { kind: 'stopped' };

  let phase: Phase = { kind: 'idle' };
  let status: ServerStatus = { kind: 'stopped' };
  let pingHandle: unknown = null;
  let cached: ListToolsResult | undefined;
  let activeListeners: { client: UpstreamClient; off: () => void } | null = null;
  let pendingStart: Promise<void> | null = null;
  let pendingRestart: Promise<void> | null = null;

  function setStatus(next: ServerStatus): void {
    status = next;
    for (const handler of handlers.status) {
      try {
        handler(next);
      } catch (error) {
        log.warn({ err: error }, 'session status handler threw');
      }
    }
  }

  function emitToolsListChanged(): void {
    for (const handler of handlers.tools_list_changed) {
      try {
        handler();
      } catch (error) {
        log.warn({ err: error }, 'session tools_list_changed handler threw');
      }
    }
  }

  function clearPing(): void {
    if (pingHandle !== null) {
      scheduler.clearInterval(pingHandle);
      pingHandle = null;
    }
  }

  function detachClientListeners(): void {
    if (activeListeners) {
      activeListeners.off();
      activeListeners = null;
    }
  }

  function backoffMs(failedAttempt: number): number {
    const exp = backoff.initialMs * Math.pow(backoff.factor, Math.max(0, failedAttempt - 1));
    return Math.min(exp, backoff.maxMs);
  }

  async function refreshTools(client: UpstreamClient): Promise<void> {
    try {
      cached = await client.listTools();
    } catch (error) {
      log.debug({ err: error }, 'failed to refresh upstream tools list');
    }
  }

  function attachClient(client: UpstreamClient): void {
    const onToolsListChanged = (): void => {
      void refreshTools(client).then(() => {
        emitToolsListChanged();
      });
    };
    const onExit = (info: { intentional: boolean }): void => {
      if (info.intentional) {
        return;
      }
      handleUnexpectedExit(client);
    };
    client.on('tools_list_changed', onToolsListChanged);
    client.on('exit', onExit);
    activeListeners = {
      client,
      off: () => {
        client.off('tools_list_changed', onToolsListChanged);
        client.off('exit', onExit);
      },
    };
  }

  function handleUnexpectedExit(client: UpstreamClient): void {
    if (phase.kind !== 'connected' || phase.client !== client) {
      return;
    }
    detachClientListeners();
    clearPing();
    // The connection that just dropped counts as the first failed attempt of a
    // new retry sequence — the next try is attempt #2.
    scheduleRetry(1, new Error('upstream client exited'));
  }

  function scheduleRetry(failedAttempt: number, lastError: Error): void {
    if (phase.kind === 'stopped' || phase.kind === 'auth_required') {
      return;
    }
    const delayMs = backoffMs(failedAttempt);
    const nextAttempt = failedAttempt + 1;
    const nextRetryAt = new Date(scheduler.now().getTime() + delayMs);
    const retryHandle = scheduler.setTimeout(() => {
      if (phase.kind !== 'waiting') {
        return;
      }
      phase = { kind: 'idle' };
      void runConnectAttempt(nextAttempt);
    }, delayMs);
    phase = { kind: 'waiting', attempt: nextAttempt, retryHandle };
    setStatus({ kind: 'error', error: lastError, nextRetryAt });
  }

  function startPing(client: UpstreamClient): void {
    clearPing();
    pingHandle = scheduler.setInterval(() => {
      if (phase.kind !== 'connected' || phase.client !== client) {
        return;
      }
      void client.ping().catch((error: unknown) => {
        if (phase.kind !== 'connected' || phase.client !== client) {
          return;
        }
        log.debug({ err: error }, 'upstream ping failed; treating as transport loss');
        // Trigger the same recovery path as an unexpected exit.
        const failedClient = phase.client;
        detachClientListeners();
        clearPing();
        void failedClient.disconnect().catch(() => undefined);
        scheduleRetry(1, error instanceof Error ? error : new Error(errorMessage(error)));
      });
    }, pingIntervalMs);
  }

  async function runConnectAttempt(attempt: number): Promise<void> {
    if (phase.kind === 'stopped' || phase.kind === 'auth_required') {
      return;
    }
    const client = createClient(config, {
      logger: baseLogger,
      ...(serverName !== undefined ? { serverName } : {}),
      ...(deps.processEnv !== undefined ? { processEnv: deps.processEnv } : {}),
      ...(deps.connectTimeoutMs !== undefined ? { connectTimeoutMs: deps.connectTimeoutMs } : {}),
    });
    phase = { kind: 'starting', attempt, client };
    setStatus({ kind: 'starting', attempt });

    try {
      await client.connect();
    } catch (error) {
      if ((phase as Phase).kind === 'stopped' || (phase as Phase).kind === 'auth_required') {
        await client.disconnect().catch(() => undefined);
        return;
      }
      if (isAuthRequiredError(error)) {
        await client.disconnect().catch(() => undefined);
        phase = { kind: 'auth_required' };
        setStatus({ kind: 'auth_required', reason: error.message });
        return;
      }
      await client.disconnect().catch(() => undefined);
      scheduleRetry(attempt, error instanceof Error ? error : new Error(errorMessage(error)));
      return;
    }

    if ((phase as Phase).kind !== 'starting') {
      await client.disconnect().catch(() => undefined);
      return;
    }

    attachClient(client);
    await refreshTools(client);
    phase = { kind: 'connected', client };
    setStatus({ kind: 'connected', since: scheduler.now() });
    startPing(client);
  }

  function start(): Promise<void> {
    if (pendingStart) {
      return pendingStart;
    }
    if (phase.kind !== 'idle') {
      return Promise.resolve();
    }
    const promise = runConnectAttempt(1).finally(() => {
      if (pendingStart === promise) {
        pendingStart = null;
      }
    });
    pendingStart = promise;
    return promise;
  }

  function restart(): Promise<void> {
    if (pendingRestart) {
      return pendingRestart;
    }
    if (phase.kind === 'stopped') {
      return Promise.resolve();
    }
    const promise = (async () => {
      await teardown({ keepStopped: false });
      await runConnectAttempt(1);
    })().finally(() => {
      if (pendingRestart === promise) {
        pendingRestart = null;
      }
    });
    pendingRestart = promise;
    return promise;
  }

  async function teardown(opts: { keepStopped: boolean }): Promise<void> {
    // Snapshot the current phase and transition synchronously *before* any
    // await so that concurrent `listTools` / `callTool` / `ping` calls during
    // the disconnect see a non-connected state and fail fast rather than
    // racing against a client that's actively being torn down.
    const previous = phase;
    phase = opts.keepStopped ? { kind: 'stopped' } : { kind: 'idle' };
    clearPing();
    detachClientListeners();
    if (previous.kind === 'waiting') {
      scheduler.clearTimeout(previous.retryHandle);
    }
    if (previous.kind === 'connected') {
      await previous.client.disconnect().catch(() => undefined);
    } else if (previous.kind === 'starting' && previous.client) {
      await previous.client.disconnect().catch(() => undefined);
    }
  }

  async function dispose(): Promise<void> {
    if (phase.kind === 'stopped') {
      return;
    }
    await teardown({ keepStopped: true });
    setStatus({ kind: 'stopped' });
  }

  function requireConnectedClient(): UpstreamClient {
    if (phase.kind !== 'connected') {
      throw new UpstreamNotConnectedError(serverName);
    }
    return phase.client;
  }

  return {
    serverName,
    get status(): ServerStatus {
      return status;
    },
    start,
    restart,
    dispose,
    cachedTools: () => cached,
    async listTools() {
      return requireConnectedClient().listTools();
    },
    async callTool(name, args, opts) {
      return requireConnectedClient().callTool(name, args, opts);
    },
    async ping() {
      return requireConnectedClient().ping();
    },
    on(event, handler) {
      handlers[event].add(handler);
    },
    off(event, handler) {
      handlers[event].delete(handler);
    },
  };
}
