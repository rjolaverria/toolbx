import type { Logger, ServerConfig, ServerStatus, TokenStore } from '@toolbox/core';

import {
  UpstreamAuthExpiredError,
  UpstreamAuthRequiredError,
  UpstreamNotConnectedError,
} from './errors.js';
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
    tokenStore?: TokenStore | undefined;
  },
) => UpstreamClient;

export interface CreateUpstreamSessionDeps {
  logger: Logger;
  serverName?: string;
  processEnv?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
  pingIntervalMs?: number;
  backoff?: Partial<UpstreamSessionBackoff>;
  /**
   * Token store backing OAuth credentials, forwarded to the HTTP upstream
   * client so it can build a `ToolBoxOAuthProvider`. Omitted for non-OAuth
   * servers.
   */
  tokenStore?: TokenStore;
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
    ...(deps.tokenStore !== undefined ? { tokenStore: deps.tokenStore } : {}),
  });
};

function isAuthRequiredError(error: unknown): error is UpstreamAuthRequiredError {
  return error instanceof UpstreamAuthRequiredError;
}

function isAuthExpiredError(error: unknown): error is UpstreamAuthExpiredError {
  return error instanceof UpstreamAuthExpiredError;
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
    | { kind: 'auth_expired' }
    | { kind: 'stopped' };

  let phase: Phase = { kind: 'idle' };
  let status: ServerStatus = { kind: 'stopped' };
  let pingHandle: unknown = null;
  let authRecoveryHandle: unknown = null;
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

  function clearAuthRecovery(): void {
    if (authRecoveryHandle !== null) {
      scheduler.clearTimeout(authRecoveryHandle);
      authRecoveryHandle = null;
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
      // An auth failure on tools/list (e.g. initialize succeeded but the token
      // aged out before the list call, or refresh failed only here) must not be
      // swallowed: it would leave the session marked `connected` with no tools
      // and an unreachable re-auth surface. Propagate it so the caller can
      // transition to auth_expired/auth_required. Other refresh failures are
      // non-fatal and stay swallowed.
      if (isAuthExpiredError(error) || isAuthRequiredError(error)) {
        throw error;
      }
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

  function setAuthExpired(reason: string): void {
    phase = { kind: 'auth_expired' };
    setStatus({ kind: 'auth_expired', reason });
  }

  /**
   * Transition to `auth_expired` and, when no tool list was ever cached, fall
   * back to the connection manager's reconnect backoff. With tools cached the
   * server stays callable and recovery is call-driven (SPECS §4.6.2); with
   * nothing cached the runtime publishes no tools, so no downstream call can
   * reach the session and only a reconnect can carry it back after the user
   * re-authenticates. `recoveryAttempt` seeds the backoff sequence.
   */
  function enterAuthExpired(reason: string, recoveryAttempt: number): void {
    setAuthExpired(reason);
    if (cached === undefined) {
      scheduleAuthRecovery(recoveryAttempt);
    }
  }

  function scheduleAuthRecovery(failedAttempt: number): void {
    clearAuthRecovery();
    const delayMs = backoffMs(failedAttempt);
    const nextAttempt = failedAttempt + 1;
    authRecoveryHandle = scheduler.setTimeout(() => {
      authRecoveryHandle = null;
      if (phase.kind !== 'auth_expired') {
        return;
      }
      phase = { kind: 'idle' };
      void runConnectAttempt(nextAttempt);
    }, delayMs);
  }

  function scheduleRetry(failedAttempt: number, lastError: Error): void {
    if (
      phase.kind === 'stopped' ||
      phase.kind === 'auth_required' ||
      phase.kind === 'auth_expired'
    ) {
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
        detachClientListeners();
        clearPing();
        void client.disconnect().catch(() => undefined);
        if (isAuthExpiredError(error)) {
          // An idle token aged out and the keepalive ping hit the SDK's refresh
          // path. This is mid-session expiry, not transport loss: keep the
          // cached tools published and surface `auth_expired` so the next call
          // drives re-auth recovery, matching the call-path behavior (§4.6.2).
          // If nothing was ever cached, enterAuthExpired falls back to a
          // reconnect since no downstream call can reach this session.
          enterAuthExpired(error.message, 1);
          return;
        }
        log.debug({ err: error }, 'upstream ping failed; treating as transport loss');
        // Trigger the same recovery path as an unexpected exit.
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
      ...(deps.tokenStore !== undefined ? { tokenStore: deps.tokenStore } : {}),
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
        if (phase.kind !== 'starting' || phase.client !== client) {
          return;
        }
        phase = { kind: 'auth_required' };
        setStatus({ kind: 'auth_required', reason: error.message });
        return;
      }
      if (isAuthExpiredError(error)) {
        // Stored credentials aged out. When a tool list was already cached
        // (mid-session expiry), hold in `auth_expired` with no backoff loop:
        // the server stays callable, so the next tool call re-reads the token
        // store and retries the connect — call-driven recovery (SPECS §4.6.2).
        //
        // When nothing was ever cached (the very first connect failed), no
        // downstream `tools/call` can reach this server, so call-driven
        // recovery can never fire. Fall back to the connection manager's
        // reconnect backoff so the session self-heals after the user runs
        // `tlbx auth login`, without a gateway restart. This is connection
        // recovery, not proactive token refresh — refresh still happens lazily
        // inside the SDK on each connect.
        await client.disconnect().catch(() => undefined);
        // A dispose()/restart() may have run during the disconnect await,
        // moving us out of this attempt. Re-check before mutating shared state
        // so a stale attempt cannot resurrect a torn-down session or clobber a
        // newer connect attempt with an `auth_expired` phase and reconnect timer.
        if (phase.kind !== 'starting' || phase.client !== client) {
          return;
        }
        enterAuthExpired(error.message, attempt);
        return;
      }
      await client.disconnect().catch(() => undefined);
      scheduleRetry(attempt, error instanceof Error ? error : new Error(errorMessage(error)));
      return;
    }

    const active = phase as Phase;
    if (active.kind !== 'starting' || active.client !== client) {
      // A dispose()/restart() during the connect await moved us out of this
      // attempt (or started a newer one), so this resolved client is stale.
      await client.disconnect().catch(() => undefined);
      return;
    }

    // Load the initial tool list before marking connected so an auth failure on
    // tools/list surfaces the auth state instead of a tools-less "connected".
    let refreshError: unknown = null;
    try {
      await refreshTools(client);
    } catch (error) {
      refreshError = error;
    }

    // The listTools await is another point where dispose()/restart() can move
    // us out of this attempt; re-check before committing any phase change.
    const settled = phase as Phase;
    if (settled.kind !== 'starting' || settled.client !== client) {
      await client.disconnect().catch(() => undefined);
      return;
    }

    if (isAuthRequiredError(refreshError)) {
      await client.disconnect().catch(() => undefined);
      phase = { kind: 'auth_required' };
      setStatus({ kind: 'auth_required', reason: refreshError.message });
      return;
    }
    if (isAuthExpiredError(refreshError)) {
      await client.disconnect().catch(() => undefined);
      enterAuthExpired(refreshError.message, attempt);
      return;
    }

    attachClient(client);
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
    clearAuthRecovery();
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

  async function callToolWithAuthRecovery(
    name: string,
    args: Record<string, unknown> | undefined,
    opts?: UpstreamCallToolOptions,
  ): Promise<CallToolResult> {
    if (phase.kind === 'auth_expired') {
      // Recovery on next call (SPECS §4.6.2): rebuild the client so it re-reads
      // the token store, then retry the connect. This succeeds once the user
      // has re-authenticated out of band via `tlbx auth login`. Clear any
      // pending background reconnect first so this call drives the single
      // reconnect rather than racing a scheduled one.
      clearAuthRecovery();
      await runConnectAttempt(1);
    }
    if (phase.kind !== 'connected') {
      if (phase.kind === 'auth_expired') {
        throw UpstreamAuthExpiredError.forServer(serverName);
      }
      if (phase.kind === 'auth_required') {
        // The reconnect found the stored token gone (e.g. revoked or logged
        // out), so the upstream now needs a fresh login rather than a refresh.
        // Surface the re-auth guidance instead of a generic not-connected error.
        throw UpstreamAuthRequiredError.forMissingOAuthToken(serverName);
      }
      throw new UpstreamNotConnectedError(serverName);
    }
    const client = phase.client;
    try {
      return await client.callTool(name, args, opts);
    } catch (error) {
      // A mid-session token expiry surfaces here. Drop to `auth_expired` so the
      // next call re-reads the store and retries the connect, then rethrow so
      // the caller renders the structured re-auth message.
      if (isAuthExpiredError(error) && phase.kind === 'connected' && phase.client === client) {
        detachClientListeners();
        clearPing();
        await client.disconnect().catch(() => undefined);
        // A dispose()/restart() may have run during the disconnect await; only
        // transition if we are still this connected client, so a stale call
        // cannot drag a stopped or newer-starting session back to auth_expired.
        if (phase.kind === 'connected' && phase.client === client) {
          enterAuthExpired(error.message, 1);
        }
      }
      throw error;
    }
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
      return callToolWithAuthRecovery(name, args, opts);
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
