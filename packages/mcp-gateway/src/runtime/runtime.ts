import {
  createStatusRegistry,
  type Logger,
  type ServerConfig,
  type ServerStatus,
  type StatusRegistry,
  type ToolboxConfig,
} from '@toolbox/core';

import {
  registerToolsCallHandler,
  registerToolsListHandler,
  type UpstreamSessionLookup,
} from '../downstream-server/handlers/index.js';
import type { RegisterDownstreamHandlers } from '../downstream-server/types.js';
import { createToolRegistry, type ToolRegistry } from '../registry/index.js';
import { createUpstreamSession, type UpstreamSession } from '../upstream-client/index.js';

export interface CreateUpstreamSessionForRuntime {
  (
    serverName: string,
    config: ServerConfig,
    deps: { logger: Logger; processEnv?: NodeJS.ProcessEnv },
  ): UpstreamSession;
}

export interface CreateGatewayRuntimeDeps {
  config: ToolboxConfig;
  logger: Logger;
  processEnv?: NodeJS.ProcessEnv;
  /** Test seam: override how upstream sessions are constructed. */
  createSession?: CreateUpstreamSessionForRuntime;
}

export interface GatewayRuntime {
  readonly statusRegistry: StatusRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly upstreams: UpstreamSessionLookup;
  readonly registerHandlers: RegisterDownstreamHandlers;
  /**
   * Kicks off `start()` on every enabled upstream session and returns
   * immediately. Sessions own their own retry/backoff, so `serve` accepts
   * MCP requests as soon as the downstream binds — `tools/list` simply
   * yields an empty set until the first upstream finishes connecting.
   */
  startUpstreams(): void;
  /** Tear down every upstream session in parallel. */
  dispose(): Promise<void>;
}

const defaultCreateSession: CreateUpstreamSessionForRuntime = (name, config, deps) =>
  createUpstreamSession(config, {
    logger: deps.logger,
    serverName: name,
    ...(deps.processEnv !== undefined ? { processEnv: deps.processEnv } : {}),
  });

export function createGatewayRuntime(deps: CreateGatewayRuntimeDeps): GatewayRuntime {
  const log = deps.logger.child({ component: 'gateway-runtime' });
  const statusRegistry = createStatusRegistry(deps.config);
  const toolRegistry = createToolRegistry({ namespacing: deps.config.namespacing });
  const sessions = new Map<string, UpstreamSession>();
  const create = deps.createSession ?? defaultCreateSession;

  const upstreams: UpstreamSessionLookup = {
    get: (name) => sessions.get(name),
  };

  function syncToolRegistry(name: string, session: UpstreamSession, status: ServerStatus): void {
    const tools = status.kind === 'connected' ? (session.cachedTools()?.tools ?? []) : [];
    toolRegistry.setServerEntry({
      serverName: name,
      status,
      enabled: true,
      tools,
    });
  }

  function syncStatusRegistry(name: string, session: UpstreamSession, status: ServerStatus): void {
    const toolCount = status.kind === 'connected' ? (session.cachedTools()?.tools.length ?? 0) : 0;
    try {
      statusRegistry.update(name, { status, toolCount });
    } catch (error) {
      // The state machine in @toolbox/core rejects illegal transitions; the
      // session shouldn't produce them, but guard so a misbehaving upstream
      // can't take down the gateway.
      log.warn({ err: error, server: name }, 'failed to update status registry');
    }
  }

  for (const [name, server] of Object.entries(deps.config.servers)) {
    if (!server.enabled) {
      continue;
    }

    const session = create(name, server, {
      logger: log,
      ...(deps.processEnv !== undefined ? { processEnv: deps.processEnv } : {}),
    });
    sessions.set(name, session);

    session.on('status', (status) => {
      syncStatusRegistry(name, session, status);
      syncToolRegistry(name, session, status);
    });

    session.on('tools_list_changed', () => {
      const status = session.status;
      if (status.kind !== 'connected') {
        return;
      }
      // Update toolCount only — the state machine rejects self-transitions
      // (connected → connected), so we must not re-pass `status` here.
      const toolCount = session.cachedTools()?.tools.length ?? 0;
      try {
        statusRegistry.update(name, { toolCount });
      } catch (error) {
        log.warn({ err: error, server: name }, 'failed to update status registry tool count');
      }
      syncToolRegistry(name, session, status);
    });
  }

  const registerHandlers: RegisterDownstreamHandlers = (server, downstreamSession) => {
    registerToolsListHandler(server, downstreamSession, toolRegistry);
    registerToolsCallHandler(server, downstreamSession, toolRegistry, upstreams);
  };

  return {
    statusRegistry,
    toolRegistry,
    upstreams,
    registerHandlers,
    startUpstreams() {
      for (const [name, session] of sessions) {
        // Fire-and-forget: the session's internal backoff handles failures.
        // We only log unhandled rejections so they aren't silent.
        void session.start().catch((error: unknown) => {
          log.warn({ err: error, server: name }, 'upstream session.start() rejected');
        });
      }
    },
    async dispose() {
      const entries = [...sessions.entries()];
      sessions.clear();
      await Promise.all(
        entries.map(async ([name, session]) => {
          try {
            await session.dispose();
          } catch (error) {
            log.warn({ err: error, server: name }, 'error disposing upstream session');
          }
        }),
      );
    },
  };
}
