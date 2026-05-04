import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  routeToolCall,
  type Logger,
  type NamespaceOptions,
  type RouteResult,
  type SessionLookup,
} from '@toolbox/core';

import type { BootstrapToolRegistry } from '../../bootstrap-tools/index.js';
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
  /**
   * Resolves the configured per-server `timeoutMs`. The runtime feeds this
   * from `ServerConfig.timeoutMs`. Returning `undefined` means "no router-side
   * timeout" — the upstream client may still enforce its own.
   */
  resolveTimeoutMs?: (serverName: string) => number | undefined;
  /** Logger used to emit one structured entry per completed call. */
  logger?: Logger;
  /**
   * Bootstrap tools (M4-03+). Calls whose name matches a registered bootstrap
   * tool short-circuit upstream routing. The registry is required so the
   * handler signature is unambiguous; pass an empty registry when bootstrap
   * tools are disabled.
   */
  bootstrap: BootstrapToolRegistry;
}

function outcomeOf(result: RouteResult): string {
  if (result.kind === 'upstream_error') {
    return `upstream_error:${result.error.code}`;
  }
  return result.kind;
}

function logCompletion(
  logger: Logger | undefined,
  result: RouteResult,
  meta: { server: string | undefined; tool: string; durationMs: number },
): void {
  if (logger === undefined) {
    return;
  }
  const fields = {
    server: meta.server,
    tool: meta.tool,
    durationMs: meta.durationMs,
    outcome: outcomeOf(result),
  };
  if (result.kind === 'ok') {
    logger.info(fields, 'tools/call ok');
  } else {
    logger.warn(fields, 'tools/call failed');
  }
}

function toMcpError(name: string, result: Exclude<RouteResult, { kind: 'ok' }>): McpError {
  switch (result.kind) {
    case 'unknown_tool':
      return new McpError(ErrorCode.MethodNotFound, `Unknown tool "${name}"`);
    case 'server_unavailable': {
      const reason = 'reason' in result.status ? `: ${result.status.reason}` : '';
      return new McpError(
        ErrorCode.InternalError,
        `Upstream server "${result.server}" is unavailable (status: ${result.status.kind}${reason})`,
        { server: result.server, status: result.status },
      );
    }
    case 'invalid_args': {
      const message = result.issues.map((issue) => issue.message).join('; ');
      return new McpError(ErrorCode.InvalidParams, message, { issues: result.issues });
    }
    case 'upstream_error': {
      const { error } = result;
      if (error.code === 'timeout') {
        return new McpError(
          ErrorCode.InternalError,
          `Upstream tool "${error.tool}" on server "${error.server}" timed out after ${error.timeoutMs}ms`,
          {
            server: error.server,
            tool: error.tool,
            code: 'timeout',
            timeoutMs: error.timeoutMs,
          },
        );
      }
      const data: Record<string, unknown> = {
        server: error.server,
        tool: error.tool,
        code: 'upstream',
      };
      if (error.upstreamCode !== undefined) {
        data.upstreamCode = error.upstreamCode;
      }
      if (error.upstreamData !== undefined) {
        data.upstreamData = error.upstreamData;
      }
      return new McpError(ErrorCode.InternalError, error.message, data);
    }
  }
}

/**
 * Registers the `tools/call` handler. The handler is a thin adapter that
 * delegates routing decisions to `routeToolCall` in `@toolbox/core` and
 * converts the discriminated `RouteResult` into MCP-protocol responses.
 *
 * Argument validation is delegated to the upstream server — ToolBox does not
 * second-guess JSON Schema enforcement. The router enforces a structural
 * guard (arguments must be an object) for callers that bypass the SDK's
 * request schema.
 *
 * Per-server timeouts come from `resolveTimeoutMs`. Every completed call —
 * success or failure — is logged once with `{ server, tool, durationMs,
 * outcome }`. The handler never lets an upstream failure crash the
 * downstream server: every routing branch maps to a structured `McpError`.
 */
export function registerToolsCallHandler(
  server: Server,
  session: DownstreamSession,
  registry: ToolRegistry,
  upstreams: UpstreamSessionLookup,
  options: RegisterToolsCallHandlerOptions,
): void {
  const { namespacing, resolveTimeoutMs, logger, bootstrap } = options;

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    requireReady(session);

    const { name, arguments: args } = request.params;

    const bootstrapTool = bootstrap.find(name);
    if (bootstrapTool !== undefined) {
      // Bootstrap tools reserve their exposed names — if an upstream server
      // happens to namespace a tool to the same name (e.g. an upstream named
      // `toolbox` exposing `search_tools`), the bootstrap version wins and
      // the upstream tool is unreachable through this dispatch. The matching
      // `tools/list` filter keeps the listing consistent. Warn once per call
      // so operators can spot the collision in logs.
      if (registry.find(name) !== undefined) {
        logger?.warn(
          { tool: name },
          'bootstrap tool shadows an upstream tool with the same exposed name',
        );
      }
      const startedAt = Date.now();
      let result: CallToolResult;
      try {
        result = await bootstrapTool.invoke(args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = {
          isError: true,
          content: [{ type: 'text', text: `bootstrap tool "${name}" threw: ${message}` }],
        };
      }
      const durationMs = Date.now() - startedAt;
      const isError = result.isError === true;
      logger?.[isError ? 'warn' : 'info'](
        {
          server: 'toolbox',
          tool: name,
          durationMs,
          outcome: isError ? 'bootstrap_error' : 'ok',
        },
        isError ? 'tools/call failed' : 'tools/call ok',
      );
      return result;
    }

    let serverName: string | undefined;
    const entry = registry.find(name);
    if (entry !== undefined) {
      serverName = entry.serverName;
    }
    const timeoutMs =
      serverName !== undefined && resolveTimeoutMs !== undefined
        ? resolveTimeoutMs(serverName)
        : undefined;

    const startedAt = Date.now();
    const result = await routeToolCall({
      exposedName: name,
      args,
      registry,
      sessions: upstreams,
      namespacing,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    const durationMs = Date.now() - startedAt;

    logCompletion(logger, result, {
      server: serverName ?? (result.kind === 'server_unavailable' ? result.server : undefined),
      tool: name,
      durationMs,
    });

    if (result.kind === 'ok') {
      return result.result;
    }
    throw toMcpError(name, result);
  });
}
