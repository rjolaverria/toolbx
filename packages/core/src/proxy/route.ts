import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { parseExposedName, type NamespaceOptions } from '../namespace/index.js';
import type { ServerStatus } from '../server-status/types.js';

import type { RegistryView } from './registry-view.js';
import type { RoutedCallToolResult, SessionLookup } from './session-view.js';

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
  | { readonly kind: 'upstream_error'; readonly error: RouteUpstreamError };

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
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUpstreamTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'UpstreamCallToolTimeoutError' ||
      (err instanceof McpError && err.code === -32001))
  );
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
 *    - session exists but its status is not `connected` →
 *      `server_unavailable` with the live status. This covers `disabled`,
 *      `starting`, `error`, `auth_required`, `auth_expired`, and `stopped`.
 *    - session is connected but the tool is genuinely absent → `unknown_tool`.
 * 3. If the registry has the entry, the router validates the argument shape,
 *    re-resolves the session (race-safe recheck after `find`), and forwards
 *    the call. Upstream throws are wrapped as `upstream_error`. When
 *    `timeoutMs` is set and exceeded, the call is aborted and reported as a
 *    `timeout` variant.
 */
export async function routeToolCall(params: RouteToolCallParams): Promise<RouteResult> {
  const { exposedName, args, registry, sessions, namespacing, signal, timeoutMs } = params;

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
  if (entry === undefined) {
    const session = sessions.get(parsed.serverName);
    if (session === undefined) {
      return { kind: 'unknown_tool' };
    }
    if (session.status.kind !== 'connected') {
      return { kind: 'server_unavailable', server: parsed.serverName, status: session.status };
    }
    return { kind: 'unknown_tool' };
  }

  if (args !== undefined && !isPlainObject(args)) {
    return {
      kind: 'invalid_args',
      issues: [{ path: [], message: 'arguments must be an object' }],
    };
  }

  const session = sessions.get(entry.serverName);
  if (session === undefined) {
    return {
      kind: 'server_unavailable',
      server: entry.serverName,
      status: { kind: 'stopped' },
    };
  }
  if (session.status.kind !== 'connected') {
    return { kind: 'server_unavailable', server: entry.serverName, status: session.status };
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const callOpts: { signal: AbortSignal; timeoutMs?: number } = { signal: controller.signal };
  if (timeoutMs !== undefined) {
    callOpts.timeoutMs = timeoutMs;
  }

  try {
    const result = await session.callTool(entry.upstreamName, args, callOpts);
    return { kind: 'ok', result };
  } catch (err) {
    if (timedOut && timeoutMs !== undefined) {
      const message = err instanceof Error ? err.message : `timed out after ${timeoutMs}ms`;
      return {
        kind: 'upstream_error',
        error: {
          code: 'timeout',
          server: entry.serverName,
          tool: entry.upstreamName,
          timeoutMs,
          message,
        },
      };
    }
    return {
      kind: 'upstream_error',
      error: describeUpstreamError(err, entry.serverName, entry.upstreamName, timeoutMs),
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal !== undefined) {
      signal.removeEventListener('abort', onCallerAbort);
    }
  }
}
