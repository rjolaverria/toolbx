/**
 * Per-MCP-session in-memory state for the downstream Toolbox server.
 *
 * One DownstreamSession is created per `Server` instance: stdio transports
 * have a single one for the life of the process; HTTP transports create one
 * per session id assigned by the SDK's `StreamableHTTPServerTransport`.
 *
 * `ready` flips to `true` when the client sends `notifications/initialized`.
 * Until then, request handlers (e.g. `tools/call`, `tools/list`) must reject.
 *
 * M4 will extend this shape with progressive-disclosure state (revealed
 * tools, last search results, etc). Keep it as a plain object — no class —
 * so reasoning about lifetime stays trivial.
 *
 * Named `DownstreamSession` to avoid collision with `UpstreamSession` from
 * the upstream-client surface.
 */
export interface DownstreamSession {
  readonly id: string;
  ready: boolean;
}

export function createDownstreamSession(id: string): DownstreamSession {
  return { id, ready: false };
}
