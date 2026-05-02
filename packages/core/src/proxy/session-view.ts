import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { ServerStatus } from '../server-status/types.js';

/**
 * The router and adapters work with whatever shape the MCP SDK's `Client`
 * returns from `callTool`, which is a wider compatibility type than the
 * strict `CallToolResultSchema` (it also accepts the legacy `{ toolResult }`
 * shape). Using this alias keeps the gateway's `UpstreamSession.callTool`
 * structurally assignable to `SessionView.callTool`.
 */
export type RoutedCallToolResult = Awaited<ReturnType<Client['callTool']>>;

export interface SessionCallToolOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Read-only slice of an upstream session the router uses. The gateway's
 * `UpstreamSession` is structurally compatible — pass it directly.
 */
export interface SessionView {
  readonly status: ServerStatus;
  callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    opts?: SessionCallToolOptions,
  ): Promise<RoutedCallToolResult>;
}

/**
 * Lookup seam. The gateway's `UpstreamSessionLookup` is structurally
 * compatible because `UpstreamSession` satisfies `SessionView`.
 */
export interface SessionLookup {
  get(serverName: string): SessionView | undefined;
}
