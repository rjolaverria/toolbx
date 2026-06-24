import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  CredentialChangedDuringRefreshError,
  SuppressedRedirectError,
  ToolBoxOAuthProvider,
  type HttpServerConfig,
  type Logger,
  type TokenStore,
} from '@rjolaverria/toolbox-core';

import { resolveEnvPlaceholders } from './env.js';
import {
  UpstreamAuthExpiredError,
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
  /**
   * Token store backing OAuth credentials. Required when `config.auth.type ===
   * 'oauth'`; the client builds a `ToolBoxOAuthProvider` over it and hands it to
   * the SDK transport so the SDK can attach the access token, refresh it on a
   * 401, and persist the refreshed pair back through the store.
   */
  tokenStore?: TokenStore;
  /**
   * Token-store backend's credential-lock root (from
   * `resolveCredentialLockRoot(config.auth.storage)` — per-user/machine-global
   * for the keychain), **not** a config dir, whose per-server-name lock
   * serializes token-store mutations (P3-08/P3-09/P3-10). Forwarded to the OAuth
   * provider so an SDK-driven token refresh persists under the same lock the CLI
   * credential commands hold and cannot race a concurrent `tlbx auth logout`,
   * regardless of the `-c` config either side used.
   */
  credentialLockRoot?: string;
}

export function createHttpUpstreamClient(
  config: HttpServerConfig,
  deps: CreateHttpUpstreamClientDeps,
): UpstreamClient {
  const serverName = deps.serverName;
  const baseLogger = serverName ? deps.logger.child({ server: serverName }) : deps.logger;
  const log = baseLogger.child({ component: 'upstream-http' });
  const processEnv = deps.processEnv ?? process.env;

  const isOAuth = config.auth?.type === 'oauth';
  // Build the OAuth provider once per client. The SDK transport drives the
  // whole token lifecycle through it: it reads the stored access token via
  // `tokens()`, refreshes on a 401 and persists the new pair via `saveTokens`,
  // and — when refresh is exhausted — calls `redirectToAuthorization`, which
  // the provider answers with `SuppressedRedirectError` instead of opening a
  // browser. We classify that signal in `classifyOAuthFailure` below.
  let authProvider: ToolBoxOAuthProvider | undefined;
  if (isOAuth && serverName !== undefined && deps.tokenStore !== undefined) {
    authProvider = new ToolBoxOAuthProvider({
      serverName,
      // Placeholder redirect URL: the gateway never completes a browser flow,
      // so this never reaches a user-visible authorization request. The SDK's
      // `OAuthClientProvider` interface requires the field regardless.
      redirectUrl: new URL('http://127.0.0.1:0/unused'),
      tokenStore: deps.tokenStore,
      logger: log,
      ...(deps.credentialLockRoot !== undefined
        ? { credentialLockRoot: deps.credentialLockRoot }
        : {}),
    });
  }

  /**
   * Map an SDK auth failure surfaced from `connect()`/`callTool()`/`listTools()`
   * to a ToolBox auth error. The SDK reaches `redirectToAuthorization` (→
   * `SuppressedRedirectError`) whenever it cannot mint a usable access token —
   * either there is no stored token, or refresh failed. We disambiguate by
   * reading the store: an absent record is `auth_required` (never authenticated
   * this server); a present record that still failed is `auth_expired` (the
   * stored credentials aged out). Returns `null` for non-auth errors so callers
   * fall through to their normal error wrapping.
   */
  async function classifyOAuthFailure(error: unknown): Promise<Error | null> {
    if (!isOAuth) {
      return null;
    }
    if (
      !(error instanceof SuppressedRedirectError) &&
      !(error instanceof UnauthorizedError) &&
      // A refresh whose record was removed or replaced mid-flight (e.g. by `tlbx
      // auth logout` or a concurrent `tlbx auth login`) is an auth failure too:
      // the store re-read below classifies it — absent ⇒ auth_required, present
      // (a newer login) ⇒ auth_expired, which then recovers on the next read.
      !(error instanceof CredentialChangedDuringRefreshError)
    ) {
      return null;
    }
    log.debug(
      { err: error },
      'oauth authorization redirect suppressed in gateway runtime; classifying by stored-token presence',
    );
    if (deps.tokenStore === undefined || serverName === undefined) {
      return UpstreamAuthRequiredError.forMissingOAuthToken(serverName);
    }
    try {
      const record = await deps.tokenStore.read(serverName);
      if (record === null) {
        return UpstreamAuthRequiredError.forMissingOAuthToken(serverName);
      }
      return UpstreamAuthExpiredError.forServer(serverName, error);
    } catch (readError) {
      // A token store we cannot even read is not a recoverable refresh case —
      // surface auth_required so the user re-runs `tlbx auth login`.
      log.warn({ err: readError }, 'failed to read token store while classifying oauth failure');
      return UpstreamAuthRequiredError.forMissingOAuthToken(serverName);
    }
  }

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
        throw UpstreamAuthRequiredError.forMissingBearerToken(config.auth.tokenEnv, serverName);
      }
      headers['Authorization'] = `Bearer ${token}`;
    }
    // OAuth servers carry no static Authorization header here: the SDK
    // transport injects (and refreshes) the bearer token via `authProvider`.
    if (isOAuth && authProvider === undefined) {
      // Misconfiguration: an OAuth server reached the client without a token
      // store / server name to build the provider. Surface auth_required so the
      // user can re-run `tlbx auth login` rather than crashing the session.
      throw UpstreamAuthRequiredError.forMissingOAuthToken(serverName);
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
      ...(authProvider !== undefined ? { authProvider } : {}),
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
      const authError = await classifyOAuthFailure(error);
      if (authError !== null) {
        throw authError;
      }
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
    try {
      return await c.listTools();
    } catch (error) {
      const authError = await classifyOAuthFailure(error);
      if (authError !== null) {
        throw authError;
      }
      throw error;
    }
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
      const authError = await classifyOAuthFailure(error);
      if (authError !== null) {
        throw authError;
      }
      throw error;
    }
  }

  async function ping(): Promise<void> {
    const c = requireClient();
    try {
      await c.ping();
    } catch (error) {
      const authError = await classifyOAuthFailure(error);
      if (authError !== null) {
        throw authError;
      }
      throw error;
    }
  }

  function on<E extends UpstreamClientEvent>(event: E, handler: UpstreamClientEvents[E]): void {
    handlers[event].add(handler);
  }

  function off<E extends UpstreamClientEvent>(event: E, handler: UpstreamClientEvents[E]): void {
    handlers[event].delete(handler);
  }

  // Run an operation inside the OAuth provider's refresh-lineage scope so the
  // SDK's `tokens()` read and the `saveTokens()` it triggers (both descendants
  // of `fn`) share one per-operation cell, letting the provider detect a
  // credential rebound out from under an in-flight refresh without a concurrent
  // request's read corrupting it. A no-op for non-OAuth clients.
  function withRefreshScope<T>(fn: () => Promise<T>): Promise<T> {
    return authProvider !== undefined ? authProvider.withRefreshScope(fn) : fn();
  }

  return {
    serverName,
    connect: () => withRefreshScope(connect),
    disconnect,
    listTools: () => withRefreshScope(listTools),
    callTool: (name, args, opts) => withRefreshScope(() => callTool(name, args, opts)),
    ping: () => withRefreshScope(ping),
    on,
    off,
  };
}
