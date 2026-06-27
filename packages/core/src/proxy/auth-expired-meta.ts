/**
 * Structured marker carried on an `auth_expired` `CallToolResult._meta`.
 *
 * The downstream `tools/call` handler renders the `auth_expired` outcome as an
 * `isError: true` result with human-facing re-auth text (SPECS §4.6.2) rather
 * than a JSON-RPC error, so an MCP client can surface it to the user. That
 * text alone is not machine-classifiable: this `_meta` key lets a programmatic
 * caller such as `tlbx run` recognise the auth failure and react to it (exit
 * code 5) instead of treating it as a generic tool error.
 */
export const AUTH_EXPIRED_META_KEY = 'toolbx/authExpired';

export interface AuthExpiredMeta {
  /** The upstream server whose credentials expired. */
  readonly server: string;
}

/** Builds the `_meta` payload for an `auth_expired` result. */
export function authExpiredMeta(server: string): Record<string, AuthExpiredMeta> {
  return { [AUTH_EXPIRED_META_KEY]: { server } };
}

/**
 * Reads the structured auth-expired marker from a result's `_meta`, returning
 * `undefined` when it is absent or malformed.
 */
export function readAuthExpiredMeta(
  meta: Record<string, unknown> | undefined,
): AuthExpiredMeta | undefined {
  if (meta === undefined) {
    return undefined;
  }
  const value = meta[AUTH_EXPIRED_META_KEY];
  if (typeof value === 'object' && value !== null) {
    const server = (value as { server?: unknown }).server;
    if (typeof server === 'string' && server.length > 0) {
      return { server };
    }
  }
  return undefined;
}
