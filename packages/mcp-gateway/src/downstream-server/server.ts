import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { getToolboxVersion, type Logger } from '@toolbox/core';

import { registerLifecycleHandlers } from './handlers/lifecycle.js';
import { createDownstreamSession, type DownstreamSession } from './session.js';
import type { RegisterDownstreamHandlers } from './types.js';

export const TOOLBOX_SERVER_NAME = 'toolbox' as const;

export const TOOLBOX_SERVER_CAPABILITIES = {
  tools: { listChanged: true },
  logging: {},
} as const;

export interface BuildToolboxMcpServerDeps {
  logger: Logger;
  /**
   * Stable identifier for this MCP session. stdio transports pass `'stdio'`;
   * HTTP transports pass the SDK-issued session id so per-session state
   * (progressive-disclosure registry in M4) stays isolated.
   */
  sessionId: string;
  registerHandlers?: RegisterDownstreamHandlers | undefined;
}

export interface BuildToolboxMcpServerResult {
  server: Server;
  session: DownstreamSession;
}

/**
 * Builds a Toolbox MCP `Server` instance with shared identity, capabilities,
 * lifecycle wiring, and out-of-band error logging. Both downstream transports
 * (stdio + HTTP) use this so the M2-03/04/05 handler set wires onto either
 * transport identically. The HTTP transport calls this once per session.
 */
export function buildToolboxMcpServer(
  deps: BuildToolboxMcpServerDeps,
): BuildToolboxMcpServerResult {
  const server = new Server(
    { name: TOOLBOX_SERVER_NAME, version: getToolboxVersion() },
    { capabilities: TOOLBOX_SERVER_CAPABILITIES },
  );

  const session = createDownstreamSession(deps.sessionId);
  registerLifecycleHandlers(server, session);

  // Out-of-band protocol errors only. Handler throws are converted to
  // JSON-RPC error responses by the SDK before this fires.
  server.onerror = (error) => {
    deps.logger.warn({ err: error }, 'downstream MCP server error');
  };

  if (deps.registerHandlers) {
    deps.registerHandlers(server, session);
  }

  return { server, session };
}
