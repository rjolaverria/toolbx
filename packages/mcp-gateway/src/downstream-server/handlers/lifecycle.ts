// `initialize` and `ping` are handled internally by the SDK's `Server` class:
// the constructor's `serverInfo` and `capabilities` arguments drive
// `initialize`'s response (including protocol-version negotiation), and
// `ping` is registered automatically. We do NOT call
// `server.setRequestHandler(InitializeRequestSchema, ...)` — doing so would
// collide with the SDK's own registration.
//
// What this module owns:
//  - the `notifications/initialized` hook, via `Server.oninitialized`, which
//    flips the per-session `ready` flag;
//  - the `requireReady` guard that other handlers (tools/list, tools/call,
//    progressive-disclosure bootstrap tools) must call before doing work, so
//    a client that issues those before completing the lifecycle sees a clean
//    JSON-RPC error instead of partial state.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { DownstreamSession } from '../session.js';

export function registerLifecycleHandlers(server: Server, session: DownstreamSession): void {
  server.oninitialized = () => {
    session.ready = true;
  };
}

export function requireReady(session: DownstreamSession): void {
  if (!session.ready) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'ToolBox server has not received notifications/initialized yet',
    );
  }
}
