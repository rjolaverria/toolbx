import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { getToolBoxVersion, type Logger } from '@toolbox/core';

import { registerLifecycleHandlers } from './handlers/lifecycle.js';
import { createDownstreamSession, type DownstreamSession } from './session.js';
import type { RegisterDownstreamHandlers } from './types.js';

export const TOOLBOX_SERVER_NAME = 'toolbox' as const;

export const TOOLBOX_SERVER_CAPABILITIES = {
  tools: { listChanged: true },
  logging: {},
} as const;

export interface BuildToolBoxMcpServerDeps {
  logger: Logger;
  /**
   * Stable identifier for this MCP session. stdio transports pass `'stdio'`;
   * HTTP transports pass the SDK-issued session id so per-session state
   * (progressive-disclosure registry in M4) stays isolated.
   */
  sessionId: string;
  /**
   * Marks this session as a local control-plane caller (`tlbx run`, SPECS
   * §5.3) so the handlers exempt it from progressive disclosure. HTTP sessions
   * set this from the loopback marker; stdio sessions never do.
   */
  controlPlane?: boolean | undefined;
  registerHandlers?: RegisterDownstreamHandlers | undefined;
}

export interface BuildToolBoxMcpServerResult {
  server: Server;
  session: DownstreamSession;
}

/**
 * Builds a ToolBox MCP `Server` instance with shared identity, capabilities,
 * lifecycle wiring, and out-of-band error logging. Both downstream transports
 * (stdio + HTTP) use this so the M2-03/04/05 handler set wires onto either
 * transport identically. The HTTP transport calls this once per session.
 */
export function buildToolBoxMcpServer(
  deps: BuildToolBoxMcpServerDeps,
): BuildToolBoxMcpServerResult {
  const server = new Server(
    { name: TOOLBOX_SERVER_NAME, version: getToolBoxVersion() },
    { capabilities: TOOLBOX_SERVER_CAPABILITIES },
  );

  const session = createDownstreamSession(deps.sessionId, deps.controlPlane ?? false);
  registerLifecycleHandlers(server, session);

  // Install the single canonical close hook. Consumers (transports, the
  // gateway runtime) register cleanups via `session.onClose(...)` rather
  // than reassigning `server.onclose` themselves — the SDK property is one
  // slot and the last writer wins. Centralising it here means a transport
  // setting up its own teardown can no longer silently drop the runtime's
  // per-session listener detach.
  server.onclose = () => {
    session.runCloseCallbacks();
  };

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
