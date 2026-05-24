import {
  createSessionVisibility,
  createStatusRegistry,
  createTokenStore,
  type Logger,
  type ServerConfig,
  type ServerStatus,
  type StatusRegistry,
  type TokenStore,
  type ToolBoxConfig,
} from '@toolbox/core';

import {
  BOOTSTRAP_TOOL_NAMES,
  createBootstrapToolRegistry,
  createHideToolsBootstrap,
  createListAvailableServersBootstrap,
  createListRevealedToolsBootstrap,
  createRevealToolsBootstrap,
  registerSearchToolsBootstrap,
} from '../bootstrap-tools/index.js';
import {
  registerToolsCallHandler,
  registerToolsListHandler,
  type UpstreamSessionLookup,
} from '../downstream-server/handlers/index.js';
import { createToolsChangedNotifier } from '../downstream-server/notify-tools-changed.js';
import type { RegisterDownstreamHandlers } from '../downstream-server/types.js';
import { createToolRegistry, type ToolRegistry } from '../registry/index.js';
import { createUpstreamSession, type UpstreamSession } from '../upstream-client/index.js';

export interface CreateUpstreamSessionForRuntime {
  (
    serverName: string,
    config: ServerConfig,
    deps: { logger: Logger; processEnv?: NodeJS.ProcessEnv; tokenStore?: TokenStore },
  ): UpstreamSession;
}

export interface CreateGatewayRuntimeDeps {
  config: ToolBoxConfig;
  logger: Logger;
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Token store backing OAuth upstreams. When omitted, the runtime builds one
   * from `config.auth.storage` only if at least one enabled server uses
   * `auth.type === 'oauth'` — non-OAuth deployments never touch the keychain.
   */
  tokenStore?: TokenStore;
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
  /**
   * Force every active downstream session to re-emit
   * `notifications/tools/list_changed`. The hook exists so the future M5-03
   * `progressiveDisclosure.enabled` toggle (which changes how the per-session
   * visible set is computed without mutating the tool registry or visibility
   * state) can fan a notification out to every connected client. M4-06 wires
   * the mechanism; M5-03 owns the call site.
   */
  notifyAllSessionsToolsChanged(): void;
  /** Tear down every upstream session in parallel. */
  dispose(): Promise<void>;
}

const defaultCreateSession: CreateUpstreamSessionForRuntime = (name, config, deps) =>
  createUpstreamSession(config, {
    logger: deps.logger,
    serverName: name,
    ...(deps.processEnv !== undefined ? { processEnv: deps.processEnv } : {}),
    ...(deps.tokenStore !== undefined ? { tokenStore: deps.tokenStore } : {}),
  });

/** True when the configured (enabled) server set includes an OAuth HTTP upstream. */
function hasOAuthUpstream(config: ToolBoxConfig): boolean {
  return Object.values(config.servers).some(
    (server) => server.enabled && server.type === 'http' && server.auth?.type === 'oauth',
  );
}

export function createGatewayRuntime(deps: CreateGatewayRuntimeDeps): GatewayRuntime {
  const log = deps.logger.child({ component: 'gateway-runtime' });
  const statusRegistry = createStatusRegistry(deps.config);
  const toolRegistry = createToolRegistry({ namespacing: deps.config.namespacing });
  const sessions = new Map<string, UpstreamSession>();
  const create = deps.createSession ?? defaultCreateSession;

  // Build the token store lazily — only when an OAuth upstream is configured —
  // so non-OAuth deployments never construct a keychain backend.
  const tokenStore: TokenStore | undefined =
    deps.tokenStore ??
    (hasOAuthUpstream(deps.config)
      ? createTokenStore(deps.config.auth.storage, { logger: deps.logger })
      : undefined);

  const upstreams: UpstreamSessionLookup = {
    get: (name) => sessions.get(name),
  };

  // Each downstream session registers a `schedule()` callback so
  // `notifyAllSessionsToolsChanged()` can fan visibility-change notifications
  // to every active client. Per-session entries are removed by the
  // server.onclose hook in registerHandlers.
  const downstreamNotifiers = new Set<() => void>();

  // Tools stay published while a server is `auth_expired`: the connection only
  // dropped because credentials aged out, and the cached tool set is what lets
  // `routeToolCall` reach the session so its next call can drive recovery
  // (re-read the token store + reconnect). Any other non-connected state clears
  // the published tools.
  function keepsPublishedTools(status: ServerStatus): boolean {
    return status.kind === 'connected' || status.kind === 'auth_expired';
  }

  function syncToolRegistry(name: string, session: UpstreamSession, status: ServerStatus): void {
    const tools = keepsPublishedTools(status) ? (session.cachedTools()?.tools ?? []) : [];
    toolRegistry.setServerEntry({
      serverName: name,
      status,
      enabled: true,
      tools,
    });
  }

  function syncStatusRegistry(name: string, session: UpstreamSession, status: ServerStatus): void {
    const toolCount = keepsPublishedTools(status) ? (session.cachedTools()?.tools.length ?? 0) : 0;
    try {
      statusRegistry.update(name, { status, toolCount });
    } catch (error) {
      // The state machine in @toolbox/core rejects illegal transitions; the
      // session shouldn't produce them, but guard so a misbehaving upstream
      // can't take down the gateway.
      log.warn({ err: error, server: name }, 'failed to update status registry');
    }
  }

  // Tracks the per-session listener detach hooks so `dispose()` can clear
  // them before tearing down sessions. Without this, late `status` /
  // `tools_list_changed` events emitted after dispose would still fire into
  // closures referencing the runtime/registries, and any consumer holding a
  // session reference (via `runtime.upstreams.get`) would keep that closure
  // graph alive — preventing GC.
  const detachers: Array<() => void> = [];

  for (const [name, server] of Object.entries(deps.config.servers)) {
    if (!server.enabled) {
      continue;
    }

    const session = create(name, server, {
      logger: log,
      ...(deps.processEnv !== undefined ? { processEnv: deps.processEnv } : {}),
      ...(tokenStore !== undefined ? { tokenStore } : {}),
    });
    sessions.set(name, session);

    const onStatus = (status: ServerStatus): void => {
      syncStatusRegistry(name, session, status);
      syncToolRegistry(name, session, status);
    };

    const onToolsListChanged = (): void => {
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
    };

    session.on('status', onStatus);
    session.on('tools_list_changed', onToolsListChanged);
    detachers.push(() => {
      session.off('status', onStatus);
      session.off('tools_list_changed', onToolsListChanged);
    });
  }

  const resolveTimeoutMs = (serverName: string): number | undefined =>
    deps.config.servers[serverName]?.timeoutMs;

  const bootstrapEnabled = deps.config.progressiveDisclosure.bootstrapTools;
  const visibilityMode = deps.config.progressiveDisclosure.mode;
  const maxSearchResults = deps.config.progressiveDisclosure.maxSearchResults;
  const autoRevealExactServerMatches =
    deps.config.progressiveDisclosure.autoRevealExactServerMatches;

  const registerHandlers: RegisterDownstreamHandlers = (server, downstreamSession) => {
    // Each downstream session owns its own bootstrap registry so the
    // session-scoped tools (reveal/hide/list-revealed) can close over a
    // fresh `SessionVisibility`. Stateless bootstrap tools (search,
    // list-available-servers) are recreated per session too so the wiring
    // stays uniform; they cost a couple of tiny closures and are negligible
    // compared to the cost of a session itself.
    const bootstrap = createBootstrapToolRegistry();
    const visibility = createSessionVisibility({
      mode: visibilityMode,
      bootstrapToolNames: bootstrapEnabled ? BOOTSTRAP_TOOL_NAMES : [],
    });

    if (bootstrapEnabled) {
      registerSearchToolsBootstrap({
        registry: bootstrap,
        toolRegistry,
        maxSearchResults,
        visibility,
        autoRevealExactServerMatches,
      });
      bootstrap.add(createListAvailableServersBootstrap({ statusRegistry }));
      bootstrap.add(createRevealToolsBootstrap({ visibility, toolRegistry }));
      bootstrap.add(createHideToolsBootstrap({ visibility }));
      bootstrap.add(createListRevealedToolsBootstrap({ visibility }));
    }

    // Read the disclosure flag dynamically per request so that a future
    // M5-03 `tlbx config set` toggle (mutating the same `deps.config` object
    // referenced here) takes effect on the next `tools/list` / `tools/call`
    // without rebuilding the runtime.
    const isDisclosureEnabled = (): boolean => deps.config.progressiveDisclosure.enabled;
    // Per-tool enable overrides come from `config.tools[exposedName].enabled`
    // (set via `tlbx tools enable/disable`, M5-02). Read per request so an
    // edit during a session takes effect on the next `tools/list` once a
    // `tools/list_changed` notification is fanned out (M5-03 territory).
    const isToolEnabled = (exposedName: string): boolean =>
      deps.config.tools[exposedName]?.enabled !== false;

    registerToolsListHandler(server, downstreamSession, toolRegistry, bootstrap, {
      visibility,
      isDisclosureEnabled,
      isToolEnabled,
    });
    registerToolsCallHandler(server, downstreamSession, toolRegistry, upstreams, {
      namespacing: deps.config.namespacing,
      resolveTimeoutMs,
      logger: log,
      bootstrap,
      visibility,
      isDisclosureEnabled,
      isToolEnabled,
    });

    const notifier = createToolsChangedNotifier({
      server,
      session: downstreamSession,
      logger: log,
    });

    // Per-session visibility changes (reveal/hide/reset) — debounce so
    // a single reveal_tools call with N names produces one notification.
    const offVisibility = visibility.on('change', () => {
      notifier.schedule();
    });
    // Global tool-registry changes (upstream connect/disconnect, tools list
    // refresh) — every active session must learn about them.
    const offRegistry = toolRegistry.subscribe(() => {
      notifier.schedule();
    });
    // Runtime-level broadcast (e.g. M5-03 toggling progressiveDisclosure.enabled)
    // — fans out to every active session even when nothing in the registry
    // changed.
    const broadcastEntry = (): void => {
      notifier.schedule();
    };
    downstreamNotifiers.add(broadcastEntry);

    // Compose teardown via the session's `onClose` registry rather than
    // reassigning `server.onclose` directly. Transports (stdio, HTTP) and
    // future handlers all register cleanups the same way, and
    // `buildToolBoxMcpServer` runs the chain when the SDK fires `onclose`.
    downstreamSession.onClose(() => {
      offVisibility();
      offRegistry();
      downstreamNotifiers.delete(broadcastEntry);
      notifier.dispose();
    });
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
    notifyAllSessionsToolsChanged() {
      for (const notify of downstreamNotifiers) {
        try {
          notify();
        } catch (error) {
          log.warn({ err: error }, 'broadcast tools-changed notifier threw');
        }
      }
    },
    async dispose() {
      const entries = [...sessions.entries()];
      sessions.clear();
      // Drive each session's own teardown first so its final status
      // transition (-> `stopped`) is mirrored into the registries, then
      // detach the listeners so any reference held by an external consumer
      // (e.g. via `runtime.upstreams.get`) cannot keep the runtime/registry
      // closures alive past dispose.
      await Promise.all(
        entries.map(async ([name, session]) => {
          try {
            await session.dispose();
          } catch (error) {
            log.warn({ err: error, server: name }, 'error disposing upstream session');
          }
        }),
      );
      while (detachers.length > 0) {
        const detach = detachers.pop();
        try {
          detach?.();
        } catch (error) {
          log.warn({ err: error }, 'error detaching upstream session listener');
        }
      }
    },
  };
}
