import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { BootstrapToolRegistry } from '../../bootstrap-tools/index.js';
import type { ToolRegistry } from '../../registry/index.js';
import type { DownstreamSession } from '../session.js';

import { requireReady } from './lifecycle.js';

/**
 * Registers the `tools/list` handler. Non-disclosure mode (M2-04) — returns
 * every namespaced tool from every connected, enabled upstream server, sorted
 * by `(serverName, upstreamName)` ascending. M4-07 will later layer the
 * progressive-disclosure on/off toggle on top of this same registration.
 *
 * Bootstrap tools (M4-03+) are prepended to the listing and reserve their
 * exposed names: any upstream tool whose namespaced name collides with a
 * bootstrap name (e.g. an upstream server literally named `toolbox` exposing
 * a tool that namespaces to `toolbox__search_tools`) is dropped from the
 * listing so it matches what `tools/call` will actually dispatch — bootstrap
 * always wins. Callers that don't register any bootstrap tools pass an empty
 * registry; the listing then matches the previous upstream-only behaviour
 * byte-for-byte.
 *
 * Pagination is intentionally not implemented; the tool registry is small
 * enough in Phase 1 that returning the full list per request is fine.
 */
export function registerToolsListHandler(
  server: Server,
  session: DownstreamSession,
  registry: ToolRegistry,
  bootstrap: BootstrapToolRegistry,
): void {
  server.setRequestHandler(ListToolsRequestSchema, () => {
    requireReady(session);
    const bootstrapTools = bootstrap.list();
    const reserved = new Set(bootstrapTools.map((tool) => tool.name));
    const upstreamTools = registry
      .list()
      .filter((entry) => !reserved.has(entry.exposedName))
      .map((entry) => entry.tool);
    return {
      tools: [...bootstrapTools, ...upstreamTools],
    };
  });
}
