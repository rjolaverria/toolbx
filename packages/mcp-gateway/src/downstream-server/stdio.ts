// Stdout is reserved for MCP protocol traffic on this transport. All logging
// must flow through `deps.logger`, which the caller is expected to configure
// with a stderr destination (see `createLogger` in @toolbox/core). Do not
// `console.log` or `process.stdout.write` from this module.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildToolboxMcpServer } from './server.js';
import type { CreateDownstreamStdioServerDeps, DownstreamStdioServer } from './types.js';

const LIFECYCLE_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

type LifecycleState = 'idle' | 'starting' | 'started' | 'stopping' | 'stopped';

export function createDownstreamStdioServer(
  deps: CreateDownstreamStdioServerDeps,
): DownstreamStdioServer {
  const log = deps.logger.child({ component: 'downstream-stdio' });
  const proc = deps.process ?? process;
  const stdin = deps.stdin ?? proc.stdin;
  const stdout = deps.stdout ?? proc.stdout;

  // Build the SDK server up front so that callers connecting it directly
  // (e.g. tests using InMemoryTransport) exercise the same handler set as
  // start(), and so any registerHandlers wiring failures surface
  // deterministically at construction time rather than during start().
  const { server } = buildToolboxMcpServer({
    logger: log,
    sessionId: 'stdio',
    registerHandlers: deps.registerHandlers,
  });

  let state: LifecycleState = 'idle';
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let pendingStop: Promise<void> | null = null;

  const onStdinEnd = (): void => {
    log.debug('stdin EOF; shutting down downstream server');
    void stop().catch((error: unknown) => {
      log.warn({ err: error }, 'error stopping downstream server on stdin EOF');
    });
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    log.debug({ signal }, 'received termination signal; shutting down downstream server');
    void stop().catch((error: unknown) => {
      log.warn({ err: error, signal }, 'error stopping downstream server on signal');
    });
  };

  function detachLifecycleListeners(): void {
    stdin.off('end', onStdinEnd);
    for (const signal of LIFECYCLE_SIGNALS) {
      proc.off(signal, onSignal);
    }
  }

  function finalizeStopped(): void {
    if (state === 'stopped') {
      return;
    }
    state = 'stopped';
    detachLifecycleListeners();
    resolveDone();
  }

  async function start(): Promise<void> {
    if (state !== 'idle') {
      throw new Error(`downstream stdio server already ${state}`);
    }
    state = 'starting';

    server.onclose = () => {
      finalizeStopped();
    };

    stdin.once('end', onStdinEnd);
    for (const signal of LIFECYCLE_SIGNALS) {
      proc.on(signal, onSignal);
    }

    const transport = new StdioServerTransport(stdin, stdout);

    try {
      await server.connect(transport);
    } catch (error) {
      finalizeStopped();
      throw error;
    }

    if ((state as LifecycleState) !== 'starting') {
      // A concurrent stop() ran while connect() was in flight (e.g. SIGINT,
      // SIGTERM, or stdin EOF arrived during startup). Let the in-progress
      // stop settle, defensively close the freshly-attached transport, and
      // surface a deterministic error so callers can react instead of
      // believing start() succeeded.
      if (pendingStop) {
        await pendingStop.catch(() => undefined);
      }
      await server.close().catch(() => undefined);
      finalizeStopped();
      throw new Error('downstream stdio server stopped during start');
    }
    state = 'started';
    log.debug('downstream stdio server started');
  }

  function stop(): Promise<void> {
    if (pendingStop) {
      return pendingStop;
    }
    if (state === 'stopped') {
      return Promise.resolve();
    }
    if (state === 'idle') {
      // start() was never called (or it failed before reaching the transport).
      // Resolve `done` so unconditional `await stop(); await done` teardown
      // patterns don't hang.
      finalizeStopped();
      return Promise.resolve();
    }
    state = 'stopping';
    pendingStop = (async () => {
      try {
        await server.close();
      } catch (error) {
        log.warn({ err: error }, 'error closing downstream MCP server');
      } finally {
        // server.onclose normally calls finalizeStopped(); guard if it didn't.
        finalizeStopped();
      }
    })();
    return pendingStop;
  }

  return {
    server,
    start,
    stop,
    get done(): Promise<void> {
      return done;
    },
  };
}
