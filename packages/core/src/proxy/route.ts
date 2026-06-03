import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { parseExposedName, type NamespaceOptions } from '../namespace/index.js';
import type { ServerStatus } from '../server-status/types.js';

import type { RegisteredToolView, RegistryView } from './registry-view.js';
import type { RoutedCallToolResult, SessionLookup } from './session-view.js';

/**
 * Executes a custom (`source: 'custom'`) tool. The router delegates here instead
 * of consulting the session lookup. The gateway supplies an implementation that
 * runs the tool through the custom-tool sandbox and maps its outcome to a
 * {@link RouteResult}. `@toolbox/core` cannot depend on `@toolbox/custom-tools`
 * (the dependency runs the other way), so the executor is injected as a seam.
 */
export interface CustomToolExecutor {
  run(
    view: RegisteredToolView,
    args: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<RouteResult>;
}

export interface RouteIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * Structured payload for `upstream_error`. Two tagged variants:
 *
 * - `timeout`: the upstream call exceeded the configured `timeoutMs`. Either
 *   the router's race timer fired, or the upstream client surfaced its own
 *   `UpstreamCallToolTimeoutError` (matched by `error.name`).
 * - `upstream`: the upstream session threw any other error. When the throw is
 *   an MCP `McpError`, the protocol `code` and any `data` payload are
 *   preserved for downstream consumers.
 */
export type RouteUpstreamError =
  | {
      readonly code: 'timeout';
      readonly server: string;
      readonly tool: string;
      readonly timeoutMs: number;
      readonly message: string;
    }
  | {
      readonly code: 'upstream';
      readonly server: string;
      readonly tool: string;
      readonly message: string;
      readonly upstreamCode?: number;
      readonly upstreamData?: unknown;
    };

/**
 * Discriminated outcome of a proxied `tools/call`. The router never throws on
 * the call paths below — every routing decision is one of these variants. The
 * downstream `tools/call` handler converts each variant into the appropriate
 * MCP-protocol response.
 */
export type RouteResult =
  | { readonly kind: 'ok'; readonly result: RoutedCallToolResult }
  | { readonly kind: 'unknown_tool' }
  | { readonly kind: 'server_unavailable'; readonly server: string; readonly status: ServerStatus }
  | { readonly kind: 'invalid_args'; readonly issues: readonly RouteIssue[] }
  | { readonly kind: 'upstream_error'; readonly error: RouteUpstreamError }
  // OAuth credentials for the server aged out mid-call (or while the session was
  // already in `auth_expired` and the recovery reconnect failed again). The
  // downstream handler renders a structured re-auth message rather than a
  // JSON-RPC error (SPECS §4.6.2).
  | { readonly kind: 'auth_expired'; readonly server: string };

export interface RouteToolCallParams {
  readonly exposedName: string;
  /** Unrefined arguments from the request. `routeToolCall` validates structure. */
  readonly args: unknown;
  readonly registry: RegistryView;
  readonly sessions: SessionLookup;
  readonly namespacing: NamespaceOptions;
  readonly signal?: AbortSignal;
  /**
   * Per-server call-tool timeout. When provided, the router races the upstream
   * call against this deadline using its own `AbortController`. If the timer
   * fires, the call is aborted and the route resolves to a `timeout` variant.
   * Independently, the value is also forwarded to the session so the upstream
   * client's own timeout enforcement runs as a fallback.
   */
  readonly timeoutMs?: number;
  /**
   * Runs `source: 'custom'` tools. Required for custom tools to be callable; a
   * custom registry entry with no executor wired resolves to `unknown_tool`
   * (the tool effectively cannot be dispatched). Upstream tools never touch it.
   */
  readonly customExecutor?: CustomToolExecutor;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `McpError.code` is typed as `number` while `ErrorCode.RequestTimeout` is an
// enum member, so a direct `===` trips `no-unsafe-enum-comparison`. Bind it
// to a typed numeric alias so the comparison stays number↔number.
const REQUEST_TIMEOUT_CODE: number = ErrorCode.RequestTimeout;

function isUpstreamTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'UpstreamCallToolTimeoutError' ||
      (err instanceof McpError && err.code === REQUEST_TIMEOUT_CODE))
  );
}

// `@toolbox/core` cannot import the gateway's `UpstreamAuthExpiredError`
// (mcp-gateway depends on core, not the reverse), so match by name — the same
// approach `isUpstreamTimeoutError` uses for the timeout error.
function isAuthExpiredError(err: unknown): boolean {
  return err instanceof Error && err.name === 'UpstreamAuthExpiredError';
}

function describeUpstreamError(
  err: unknown,
  server: string,
  tool: string,
  timeoutMs: number | undefined,
): RouteUpstreamError {
  if (isUpstreamTimeoutError(err) && timeoutMs !== undefined) {
    return {
      code: 'timeout',
      server,
      tool,
      timeoutMs,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (err instanceof McpError) {
    const base: RouteUpstreamError = {
      code: 'upstream',
      server,
      tool,
      message: err.message,
      upstreamCode: err.code,
    };
    return err.data === undefined ? base : { ...base, upstreamData: err.data };
  }
  return {
    code: 'upstream',
    server,
    tool,
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Routes a namespaced `tools/call` to the correct upstream session.
 *
 * Decision tree:
 *
 * 1. If `exposedName` cannot be parsed under the configured namespacing
 *    options, returns `unknown_tool`. Unsupported namespacing options (which
 *    `parseExposedName` would normally throw on) are also coerced to
 *    `unknown_tool` so the router's non-throwing contract holds for callers
 *    that bypass config schema validation.
 * 2. If the registry has no entry for the exposed name, the router uses the
 *    parsed server name to consult the session lookup:
 *    - no session for that server → `unknown_tool`.
 *    - session exists and its status is `auth_expired` →
 *      `auth_expired`, so the downstream handler can return structured
 *      re-auth guidance without executing a registry-missing guessed tool.
 *    - session exists but its status is not `connected` →
 *      `server_unavailable` with the live status. This covers `disabled`,
 *      `starting`, `error`, `auth_required`, and `stopped`.
 *    - session is connected but the tool is genuinely absent → `unknown_tool`.
 * 3. If the registry has the entry, the router validates the argument shape,
 *    re-resolves the session (race-safe recheck after `find`), and forwards
 *    the call. Upstream throws are wrapped as `upstream_error`. When
 *    `timeoutMs` is set and exceeded, the call is aborted and reported as a
 *    `timeout` variant.
 */
export async function routeToolCall(params: RouteToolCallParams): Promise<RouteResult> {
  const { exposedName, args, registry, sessions, namespacing, signal, timeoutMs, customExecutor } =
    params;

  let parsed: ReturnType<typeof parseExposedName>;
  try {
    parsed = parseExposedName(exposedName, namespacing);
  } catch {
    return { kind: 'unknown_tool' };
  }
  if (parsed === null) {
    return { kind: 'unknown_tool' };
  }

  const entry = registry.find(exposedName);

  // Custom tools never reach an upstream session: they are dispatched to the
  // injected executor (P3-05). Validate the argument shape first (same guard as
  // the upstream path), then delegate. A custom entry with no executor wired is
  // not dispatchable, so it surfaces as `unknown_tool`.
  if (entry?.source === 'custom') {
    if (customExecutor === undefined) {
      return { kind: 'unknown_tool' };
    }
    if (args !== undefined && !isPlainObject(args)) {
      return {
        kind: 'invalid_args',
        issues: [{ path: [], message: 'arguments must be an object' }],
      };
    }
    return customExecutor.run(entry, args, signal);
  }

  let serverName: string;
  let upstreamName: string;
  if (entry === undefined) {
    const session = sessions.get(parsed.serverName);
    if (session === undefined) {
      return { kind: 'unknown_tool' };
    }
    if (session.status.kind === 'auth_expired') {
      return { kind: 'auth_expired', server: parsed.serverName };
    } else if (session.status.kind !== 'connected') {
      return { kind: 'server_unavailable', server: parsed.serverName, status: session.status };
    } else {
      return { kind: 'unknown_tool' };
    }
  } else {
    serverName = entry.serverName;
    upstreamName = entry.upstreamName;
  }

  if (args !== undefined && !isPlainObject(args)) {
    return {
      kind: 'invalid_args',
      issues: [{ path: [], message: 'arguments must be an object' }],
    };
  }

  const session = sessions.get(serverName);
  if (session === undefined) {
    return {
      kind: 'server_unavailable',
      server: serverName,
      status: { kind: 'stopped' },
    };
  }
  // `auth_expired` is allowed through: the session's own `callTool` re-reads
  // the token store and attempts a reconnect, recovering once the user has run
  // `tlbx auth login`. Every other non-connected status short-circuits.
  if (session.status.kind !== 'connected' && session.status.kind !== 'auth_expired') {
    return { kind: 'server_unavailable', server: serverName, status: session.status };
  }

  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort();
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  const callOpts: { signal: AbortSignal; timeoutMs?: number } = { signal: controller.signal };
  if (timeoutMs !== undefined) {
    callOpts.timeoutMs = timeoutMs;
  }

  // Wrap callTool so it never rejects — we discriminate on `kind` after the
  // race. Without this, an unawaited rejection (e.g. when a slow upstream
  // finally errors after the timeout has already been reported) would surface
  // as an unhandled promise rejection.
  type CallOutcome = { kind: 'ok'; result: RoutedCallToolResult } | { kind: 'err'; err: unknown };
  const callPromise: Promise<CallOutcome> = session.callTool(upstreamName, args, callOpts).then(
    (result) => ({ kind: 'ok' as const, result }),
    (err: unknown) => ({ kind: 'err' as const, err }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal !== undefined) {
      signal.removeEventListener('abort', onCallerAbort);
    }
  };

  try {
    let outcome: CallOutcome | { kind: 'timeout' };
    if (timeoutMs === undefined) {
      outcome = await callPromise;
    } else {
      const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => {
          // Abort the controller so the upstream can terminate cooperatively,
          // but do not wait for it — the router resolves the timeout result
          // immediately so the deadline is enforced even if the session
          // ignores the signal.
          controller.abort();
          resolve({ kind: 'timeout' });
        }, timeoutMs);
      });
      outcome = await Promise.race([callPromise, timeoutPromise]);
      // Drain any later rejection from the abandoned call to keep Node from
      // logging an unhandled rejection. `callPromise` is already wrapped to
      // never reject, so this is belt-and-braces.
      void callPromise.catch(() => undefined);
    }

    if (outcome.kind === 'ok') {
      return { kind: 'ok', result: outcome.result };
    }
    if (outcome.kind === 'timeout') {
      return {
        kind: 'upstream_error',
        error: {
          code: 'timeout',
          server: serverName,
          tool: upstreamName,
          timeoutMs: timeoutMs as number,
          message: `Upstream tool "${upstreamName}" on server "${serverName}" timed out after ${String(timeoutMs)}ms`,
        },
      };
    }
    if (isAuthExpiredError(outcome.err)) {
      return { kind: 'auth_expired', server: serverName };
    }
    return {
      kind: 'upstream_error',
      error: describeUpstreamError(outcome.err, serverName, upstreamName, timeoutMs),
    };
  } finally {
    cleanup();
  }
}
