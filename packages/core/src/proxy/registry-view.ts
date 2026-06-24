import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Read-only projection of an upstream tool record. The router consumes this
 * shape rather than depending on the live registry implementation in
 * `@rjolaverria/toolbox-gateway`. The gateway's `RegisteredTool` is structurally
 * compatible.
 */
export interface RegisteredToolView {
  readonly exposedName: string;
  readonly serverName: string;
  readonly upstreamName: string;
  readonly tool: Tool;
  /**
   * Where the tool comes from. `'upstream'` (the default when absent) is a
   * proxied tool routed to an upstream session; `'custom'` is an imported
   * custom tool routed to the local custom-tool runtime (P3-05). The router
   * dispatches on this rather than on the presence of a session.
   */
  readonly source?: 'upstream' | 'custom';
}

/**
 * Read-only slice of the tool registry the router needs. The gateway's
 * `ToolRegistry.find` satisfies this interface structurally — pass it
 * directly. Tests use a `Map`-backed stub.
 *
 * The registry only exposes tools whose owning server is currently visible
 * (enabled and connected). The router relies on this contract: a `find` miss
 * means either the tool is genuinely unknown or the server is not currently
 * visible, and the router disambiguates via the session lookup.
 */
export interface RegistryView {
  find(exposedName: string): RegisteredToolView | undefined;
}
