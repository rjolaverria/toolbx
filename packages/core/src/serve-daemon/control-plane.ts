/**
 * Local control-plane marker for `tlbx run` (SPECS §5.3).
 *
 * `tlbx run` connects to the daemon over the same loopback Streamable HTTP
 * endpoint that real MCP clients (Claude, Codex, OpenCode) use, but it is a
 * local control surface whose caller has already named an exact tool — there
 * is no context window to protect, so progressive disclosure must not gate it.
 *
 * To distinguish a `tlbx run` session from a real MCP client on the same
 * loopback endpoint, `tlbx run` sends this marker header. The daemon honors it
 * only on loopback connections; for marked sessions it skips disclosure
 * entirely. Unmarked sessions keep disclosure exactly as configured, so the
 * exemption never depends on who started the daemon.
 *
 * Disclosure is not a security boundary (the endpoint is loopback-only and
 * disclosure only protects an MCP client's context window), so the marker is a
 * plain opt-in signal rather than an unforgeable secret. Global tool
 * enable/disable still applies to marked sessions.
 */

/** Header name carrying the control-plane marker. Node lowercases header keys. */
export const CONTROL_PLANE_HEADER = 'x-toolbx-control-plane';

/** Sentinel value a `tlbx run` connection sends in {@link CONTROL_PLANE_HEADER}. */
export const CONTROL_PLANE_MARKER = 'local';

/**
 * Returns `true` when `address` is an IPv4/IPv6 loopback address. Accepts the
 * IPv4-mapped IPv6 form (`::ffff:127.x.x.x`) that Node reports for IPv4
 * connections on a dual-stack listener. A missing/empty address is not
 * loopback.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address.length === 0) {
    return false;
  }
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return normalized.startsWith('127.');
}

/**
 * Returns `true` when a request carries the control-plane marker on a loopback
 * connection. `headerValue` is the raw `node:http` header value, which may be a
 * string, an array (repeated header), or `undefined` (absent).
 */
export function isControlPlaneConnection(
  remoteAddress: string | undefined,
  headerValue: string | readonly string[] | undefined,
): boolean {
  if (!isLoopbackAddress(remoteAddress)) {
    return false;
  }
  const value = typeof headerValue === 'string' ? headerValue : headerValue?.[0];
  return value === CONTROL_PLANE_MARKER;
}
