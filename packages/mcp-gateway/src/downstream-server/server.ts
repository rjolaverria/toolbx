import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { Logger } from '@toolbox/core';

import type { RegisterDownstreamHandlers } from './types.js';

export const TOOLBOX_SERVER_INFO = {
  name: 'toolbox',
  version: '0.0.0',
} as const;

export const TOOLBOX_SERVER_CAPABILITIES = {
  tools: { listChanged: true },
} as const;

export interface BuildToolboxMcpServerDeps {
  logger: Logger;
  registerHandlers?: RegisterDownstreamHandlers | undefined;
}

/**
 * Builds a Toolbox MCP `Server` instance with shared identity, capabilities,
 * and out-of-band error logging. Both downstream transports (stdio + HTTP)
 * use this so the M2-03/04/05 handler set wires onto either transport
 * identically. The HTTP transport calls this once per session.
 */
export function buildToolboxMcpServer(deps: BuildToolboxMcpServerDeps): Server {
  const server = new Server(TOOLBOX_SERVER_INFO, {
    capabilities: TOOLBOX_SERVER_CAPABILITIES,
  });

  // Out-of-band protocol errors only. Handler throws are converted to
  // JSON-RPC error responses by the SDK before this fires.
  server.onerror = (error) => {
    deps.logger.warn({ err: error }, 'downstream MCP server error');
  };

  if (deps.registerHandlers) {
    deps.registerHandlers(server);
  }

  return server;
}
