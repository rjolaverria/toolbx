/**
 * Per-MCP-session in-memory state for the downstream Toolbox server.
 *
 * One Session is created per `Server` instance: stdio transports have a
 * single Session for the life of the process; HTTP transports create one
 * Session per session id assigned by the SDK's `StreamableHTTPServerTransport`.
 *
 * `ready` flips to `true` when the client sends `notifications/initialized`.
 * Until then, request handlers (e.g. `tools/call`, `tools/list`) must reject.
 *
 * M4 will extend this shape with progressive-disclosure state (revealed
 * tools, last search results, etc). Keep it as a plain object — no class —
 * so reasoning about lifetime stays trivial.
 */
export interface Session {
  readonly id: string;
  ready: boolean;
}

export function createSession(id: string): Session {
  return { id, ready: false };
}
