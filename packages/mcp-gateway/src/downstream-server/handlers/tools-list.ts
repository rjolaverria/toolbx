import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { ToolRegistry } from '../../registry/index.js';
import type { DownstreamSession } from '../session.js';

import { requireReady } from './lifecycle.js';

/**
 * Registers the `tools/list` handler. Non-disclosure mode (M2-04) — returns
 * every namespaced tool from every connected, enabled upstream server, sorted
 * by `(serverName, upstreamName)` ascending. M4-07 will later layer the
 * progressive-disclosure on/off toggle on top of this same registration.
 *
 * Pagination is intentionally not implemented; the tool registry is small
 * enough in Phase 1 that returning the full list per request is fine.
 */
export function registerToolsListHandler(
  server: Server,
  session: DownstreamSession,
  registry: ToolRegistry,
): void {
  server.setRequestHandler(ListToolsRequestSchema, () => {
    requireReady(session);
    return {
      tools: registry.list().map((entry) => entry.tool),
    };
  });
}
