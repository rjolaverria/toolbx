import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { ToolRegistry } from '../../registry/index.js';
import type { UpstreamSession } from '../../upstream-client/index.js';
import type { DownstreamSession } from '../session.js';

import { requireReady } from './lifecycle.js';

/**
 * Lookup seam for resolving an upstream session by server name. The gateway
 * entry point (`tlbx serve`, M2-06) supplies a real implementation backed by
 * the connection manager. Tests inject a `Map`-backed stub.
 */
export interface UpstreamSessionLookup {
  get(serverName: string): UpstreamSession | undefined;
}

/**
 * Registers the `tools/call` handler. The handler is a thin proxy:
 *
 *  1. Resolve the namespaced tool name through the registry to recover the
 *     `(serverName, upstreamName)` pair.
 *  2. Look up the upstream session and confirm it is connected.
 *  3. Forward the call to `upstream.callTool(upstreamName, arguments)` and
 *     return the result object unchanged.
 *
 * Argument validation is delegated to the upstream server — Toolbox does not
 * second-guess JSON Schema enforcement. Concrete timeout and retry policy
 * lives in M3-03; this handler lets upstream errors propagate as-is.
 */
export function registerToolsCallHandler(
  server: Server,
  session: DownstreamSession,
  registry: ToolRegistry,
  upstreams: UpstreamSessionLookup,
): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    requireReady(session);

    const { name, arguments: args } = request.params;

    const entry = registry.list().find((t) => t.exposedName === name);
    if (entry === undefined) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool "${name}"`);
    }

    // M4-07 will gate this on `session`'s revealed-tool set when progressive
    // disclosure is enabled. Until then every registry entry is callable.

    const upstream = upstreams.get(entry.serverName);
    if (upstream === undefined || upstream.status.kind !== 'connected') {
      throw new McpError(
        ErrorCode.InternalError,
        `Upstream server "${entry.serverName}" is not connected`,
      );
    }

    return upstream.callTool(entry.upstreamName, args);
  });
}
