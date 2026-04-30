// Stdout is reserved for MCP protocol traffic on this transport. All logging
// must flow through `deps.logger`, which the caller is expected to configure
// with a stderr destination (see `createLogger` in @toolbox/core). Do not
// `console.log` or `process.stdout.write` from this module.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { CreateDownstreamStdioServerDeps, DownstreamStdioServer } from './types.js';

const TOOLBOX_SERVER_INFO = {
  name: 'toolbox',
  version: '0.0.0',
} as const;

const TOOLBOX_SERVER_CAPABILITIES = {
  tools: { listChanged: true },
} as const;

const LIFECYCLE_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

type LifecycleState = 'idle' | 'starting' | 'started' | 'stopping' | 'stopped';

export function createDownstreamStdioServer(
  deps: CreateDownstreamStdioServerDeps,
): DownstreamStdioServer {
  const log = deps.logger.child({ component: 'downstream-stdio' });
  const proc = deps.process ?? process;
  const stdin = deps.stdin ?? proc.stdin;
  const stdout = deps.stdout ?? proc.stdout;

  const server = new Server(TOOLBOX_SERVER_INFO, {
    capabilities: TOOLBOX_SERVER_CAPABILITIES,
  });

  // Out-of-band protocol errors only. Handler throws are converted to
  // JSON-RPC error responses by the SDK before this fires.
  server.onerror = (error) => {
    log.warn({ err: error }, 'downstream MCP server error');
  };

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

    if (deps.registerHandlers) {
      try {
        deps.registerHandlers(server);
      } catch (error) {
        finalizeStopped();
        throw error;
      }
    }

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

    if ((state as LifecycleState) === 'stopping' || (state as LifecycleState) === 'stopped') {
      // A concurrent stop() ran while connect() was in flight. Bail out.
      return;
    }
    state = 'started';
    log.debug('downstream stdio server started');
  }

  function stop(): Promise<void> {
    if (pendingStop) {
      return pendingStop;
    }
    if (state === 'idle' || state === 'stopped') {
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
