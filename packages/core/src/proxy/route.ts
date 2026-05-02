import { parseExposedName, type NamespaceOptions } from '../namespace/index.js';
import type { ServerStatus } from '../server-status/types.js';

import type { RegistryView } from './registry-view.js';
import type { RoutedCallToolResult, SessionLookup } from './session-view.js';

export interface RouteIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

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
  | { readonly kind: 'upstream_error'; readonly server: string; readonly error: Error };

export interface RouteToolCallParams {
  readonly exposedName: string;
  /** Unrefined arguments from the request. `routeToolCall` validates structure. */
  readonly args: unknown;
  readonly registry: RegistryView;
  readonly sessions: SessionLookup;
  readonly namespacing: NamespaceOptions;
  readonly signal?: AbortSignal;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Routes a namespaced `tools/call` to the correct upstream session.
 *
 * Decision tree:
 *
 * 1. If `exposedName` cannot be parsed under the configured namespacing
 *    options, returns `unknown_tool`.
 * 2. If the registry has no entry for the exposed name, the router uses the
 *    parsed server name to consult the session lookup:
 *    - no session for that server → `unknown_tool`.
 *    - session exists but its status is not `connected` →
 *      `server_unavailable` with the live status. This covers `disabled`,
 *      `starting`, `error`, `auth_required`, `auth_expired`, and `stopped`.
 *    - session is connected but the tool is genuinely absent → `unknown_tool`.
 * 3. If the registry has the entry, the router validates the argument shape,
 *    re-resolves the session (race-safe recheck after `find`), and forwards
 *    the call. Upstream throws are wrapped as `upstream_error`; non-`Error`
 *    throws are coerced into `Error` instances so the result type is uniform.
 */
export async function routeToolCall(params: RouteToolCallParams): Promise<RouteResult> {
  const { exposedName, args, registry, sessions, namespacing, signal } = params;

  const parsed = parseExposedName(exposedName, namespacing);
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

  try {
    const result =
      signal !== undefined
        ? await session.callTool(entry.upstreamName, args, { signal })
        : await session.callTool(entry.upstreamName, args);
    return { kind: 'ok', result };
  } catch (err) {
    return {
      kind: 'upstream_error',
      server: entry.serverName,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
