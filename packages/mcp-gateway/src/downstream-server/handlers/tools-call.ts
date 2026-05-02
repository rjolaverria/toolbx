import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { routeToolCall, type NamespaceOptions, type SessionLookup } from '@toolbox/core';

import type { ToolRegistry } from '../../registry/index.js';
import type { DownstreamSession } from '../session.js';

import { requireReady } from './lifecycle.js';

/**
 * Lookup seam for resolving an upstream session by server name. The gateway
 * entry point (`tlbx serve`, M2-06) supplies a real implementation backed by
 * the connection manager. Tests inject a `Map`-backed stub.
 *
 * Re-exported as the gateway's local alias for the shared `SessionLookup`
 * interface from `@toolbox/core`.
 */
export type UpstreamSessionLookup = SessionLookup;

export interface RegisterToolsCallHandlerOptions {
  namespacing: NamespaceOptions;
}

/**
 * Registers the `tools/call` handler. The handler is a thin adapter that
 * delegates routing decisions to `routeToolCall` in `@toolbox/core` and
 * converts the discriminated `RouteResult` into MCP-protocol responses.
 *
 * Argument validation is delegated to the upstream server — Toolbox does not
 * second-guess JSON Schema enforcement. The router enforces a structural
 * guard (arguments must be an object) for callers that bypass the SDK's
 * request schema. Concrete timeout and retry policy lives in M3-03; this
 * adapter lets upstream errors propagate as MCP `InternalError`s for now.
 */
export function registerToolsCallHandler(
  server: Server,
  session: DownstreamSession,
  registry: ToolRegistry,
  upstreams: UpstreamSessionLookup,
  options: RegisterToolsCallHandlerOptions,
): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    requireReady(session);

    const { name, arguments: args } = request.params;

    const result = await routeToolCall({
      exposedName: name,
      args,
      registry,
      sessions: upstreams,
      namespacing: options.namespacing,
    });

    switch (result.kind) {
      case 'ok':
        return result.result;
      case 'unknown_tool':
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool "${name}"`);
      case 'server_unavailable': {
        const reason = 'reason' in result.status ? `: ${result.status.reason}` : '';
        throw new McpError(
          ErrorCode.InternalError,
          `Upstream server "${result.server}" is unavailable (status: ${result.status.kind}${reason})`,
        );
      }
      case 'invalid_args':
        throw new McpError(
          ErrorCode.InvalidParams,
          result.issues.map((issue) => issue.message).join('; '),
        );
      case 'upstream_error':
        if (result.error instanceof McpError) {
          throw result.error;
        }
        throw new McpError(ErrorCode.InternalError, result.error.message, {
          cause: result.error,
        });
    }
  });
}
