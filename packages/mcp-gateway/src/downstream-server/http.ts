import { randomUUID } from 'node:crypto';
import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type Server as HttpListener,
  type ServerResponse,
} from 'node:http';

import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { CONTROL_PLANE_HEADER, isControlPlaneConnection } from '@toolbx/core';

import { buildToolbxMcpServer } from './server.js';
import type {
  CreateDownstreamHttpServerDeps,
  DownstreamHttpServer,
  RegisterDownstreamHandlers,
} from './types.js';

const LIFECYCLE_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const SESSION_ID_HEADER = 'mcp-session-id';
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const SHUTDOWN_RESPONSE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  connection: 'close',
} as const;

type LifecycleState = 'idle' | 'starting' | 'started' | 'stopping' | 'stopped';

interface HttpSessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export function createDownstreamHttpServer(
  deps: CreateDownstreamHttpServerDeps,
): DownstreamHttpServer {
  const log = deps.logger.child({ component: 'downstream-http' });
  const proc = deps.process ?? process;
  const sessionIdGenerator = deps.sessionIdGenerator ?? randomUUID;
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const createHttp = deps.createHttpServer ?? createNodeHttpServer;
  const registerHandlers = deps.registerHandlers;
  const { host, port, path } = deps.http;

  const sessions = new Map<string, HttpSessionEntry>();
  // Sessions whose transport hasn't yet emitted onsessioninitialized (i.e. the
  // first POST is still being processed). Tracked so stop() can close them
  // even though they aren't keyed by sessionId yet.
  const pendingSessions = new Set<HttpSessionEntry>();

  let httpServer: HttpListener | null = null;
  let state: LifecycleState = 'idle';
  let pendingStop: Promise<void> | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let boundUrl: URL | null = null;

  let inFlight = 0;
  let drainResolve: (() => void) | null = null;

  const onSignal = (signal: NodeJS.Signals): void => {
    log.debug({ signal }, 'received termination signal; shutting down downstream http server');
    void stop().catch((error: unknown) => {
      log.warn({ err: error, signal }, 'error stopping downstream http server on signal');
    });
  };

  function detachLifecycleListeners(): void {
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
    boundUrl = null;
    resolveDone();
  }

  function trackRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only POST and DELETE requests carry a finite request/response cycle that
    // we want `stop()` to drain. GET requests on the MCP path are long-lived
    // SSE streams used for server-initiated notifications; they never close
    // on their own and are torn down explicitly when sessions are closed.
    const method = req.method ?? 'GET';
    if (method !== 'POST' && method !== 'DELETE') {
      return;
    }
    inFlight++;
    let settled = false;
    const release = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      inFlight--;
      if (inFlight === 0 && drainResolve) {
        const resolve = drainResolve;
        drainResolve = null;
        resolve();
      }
    };
    res.on('close', release);
    res.on('finish', release);
  }

  function writeJsonError(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent || res.writableEnded) {
      return;
    }
    const body = JSON.stringify({ error: message });
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function writeShutdownResponse(req: IncomingMessage, res: ServerResponse): void {
    if (!res.headersSent && !res.writableEnded) {
      const body = JSON.stringify({ error: 'server shutting down' });
      res.writeHead(503, {
        ...SHUTDOWN_RESPONSE_HEADERS,
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    }
    // Drop any unread request bytes so the keep-alive socket is freed and the
    // peer cannot keep streaming into us after we've decided to stop.
    if (!req.readableEnded) {
      req.resume();
    }
  }

  function abortOversizedRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!res.headersSent && !res.writableEnded) {
      const body = JSON.stringify({ error: 'request body too large' });
      res.writeHead(413, {
        ...SHUTDOWN_RESPONSE_HEADERS,
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    }
    // Force-close the underlying socket: the client is mid-stream and we
    // can't trust them to stop sending. Destroying the request also tears
    // down the response stream, freeing the keep-alive slot.
    req.destroy();
  }

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      bytes += buf.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        throw new RequestBodyTooLargeError();
      }
      chunks.push(buf);
    }
    if (bytes === 0) {
      return undefined;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RequestBodyParseError();
    }
  }

  function createHttpSession(
    handlers: RegisterDownstreamHandlers | undefined,
    controlPlane: boolean,
  ): HttpSessionEntry {
    // Pre-generate the session id so it can be threaded into both the SDK
    // transport (which expects a `sessionIdGenerator`) and the per-session
    // `DownstreamSession` state created by `buildToolbxMcpServer`. This
    // keeps the Toolbx-level DownstreamSession.id and the MCP transport
    // session id identical.
    const sessionId = sessionIdGenerator();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
        pendingSessions.delete(session);
        log.debug({ sessionId: id }, 'http session initialized');
      },
    });
    const { server } = buildToolbxMcpServer({
      logger: log,
      sessionId,
      controlPlane,
      registerHandlers: handlers,
    });
    const session: HttpSessionEntry = { server, transport };
    pendingSessions.add(session);

    transport.onclose = () => {
      // Bookkeeping only. Do NOT call `server.close()` here: the SDK's
      // `Server.close()` calls `transport.close()` internally, which would
      // re-enter this callback and recurse until the stack overflows.
      // The MCP `Server` instance is held only via `sessions`/`pendingSessions`
      // and becomes unreachable once we drop those references; protocol-level
      // teardown (clearing pending request handlers etc.) is performed by
      // the SDK's own `_onclose` chained after this callback.
      pendingSessions.delete(session);
      const id = transport.sessionId;
      if (id) {
        sessions.delete(id);
        log.debug({ sessionId: id }, 'http session transport closed');
      }
    };

    return session;
  }

  async function routeMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const sessionId = readSessionIdHeader(req);

    if (method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          abortOversizedRequest(req, res);
          return;
        }
        if (error instanceof RequestBodyParseError) {
          writeJsonError(res, 400, 'invalid JSON body');
          return;
        }
        throw error;
      }

      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          writeJsonError(res, 404, 'session not found');
          return;
        }
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        writeJsonError(res, 400, 'mcp-session-id header required for non-initialize requests');
        return;
      }

      // Refuse to mint a new session once shutdown has begun: stop() clears
      // sessions/pendingSessions concurrently and we'd race a brand-new
      // entry into the maps after they were drained.
      if (state !== 'started') {
        writeShutdownResponse(req, res);
        return;
      }

      // The control-plane marker (§5.3) is read off the initialize request and
      // honored only on loopback connections, so a real MCP client on the same
      // loopback daemon keeps disclosure unless it explicitly opts in.
      const controlPlane = isControlPlaneConnection(
        req.socket.remoteAddress,
        req.headers[CONTROL_PLANE_HEADER],
      );
      const session = createHttpSession(registerHandlers, controlPlane);
      try {
        // The SDK declares `StreamableHTTPServerTransport.onclose` as a
        // getter/setter typed `(() => void) | undefined`, which under
        // `exactOptionalPropertyTypes` doesn't unify with the `Transport`
        // interface's optional `onclose?: () => void`. The cast bridges
        // those equivalent shapes.
        await session.server.connect(session.transport as Transport);
      } catch (error) {
        pendingSessions.delete(session);
        log.warn({ err: error }, 'failed to connect MCP server to new session transport');
        writeJsonError(res, 500, 'failed to start session');
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (method === 'GET' || method === 'DELETE') {
      if (!sessionId) {
        writeJsonError(res, 400, 'mcp-session-id header required');
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        writeJsonError(res, 404, 'session not found');
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    writeJsonError(res, 405, `method ${method} not allowed`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Reject any traffic on already-open keep-alive sockets the moment
    // shutdown begins. Without this, a request landing between
    // `state = 'stopping'` and the session map clear in stop() could either
    // see a half-cleared session map or successfully spawn a session that
    // immediately gets torn down — both observably racy.
    if (state !== 'started' && state !== 'starting') {
      writeShutdownResponse(req, res);
      return;
    }

    trackRequest(req, res);
    try {
      const requestPath = parseRequestPath(req);
      if (requestPath !== path) {
        writeJsonError(res, 404, 'not found');
        return;
      }
      await routeMcpRequest(req, res);
    } catch (error) {
      log.warn({ err: error }, 'unhandled error processing http request');
      if (!res.headersSent) {
        writeJsonError(res, 500, 'internal server error');
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }

  async function start(): Promise<void> {
    if (state !== 'idle') {
      throw new Error(`downstream http server already ${state}`);
    }
    state = 'starting';

    const listener = createHttp();
    listener.on('request', (req, res) => {
      void handle(req, res);
    });
    httpServer = listener;

    try {
      await listenOn(listener, host, port);
    } catch (error) {
      if ((state as LifecycleState) !== 'starting') {
        // listenOn rejected because a concurrent stop() closed the listener
        // mid-bind. Surface a deterministic error so callers can react, and
        // wait for stop() to finish its own teardown so the listener is
        // guaranteed shut by the time we throw.
        if (pendingStop) {
          await pendingStop.catch(() => undefined);
        }
        throw new Error('downstream http server stopped during start', { cause: error });
      }
      httpServer = null;
      finalizeStopped();
      throw error;
    }

    if ((state as LifecycleState) !== 'starting') {
      // The listener bound successfully despite a concurrent stop() — Node's
      // earlier `listener.close()` from stop() may have been a no-op because
      // the server wasn't yet listening when stop() called it. Trigger an
      // explicit close + force-close here so the listening socket doesn't
      // outlive `done`. We don't await the close callback: stop()'s
      // `waitForListenerClose` will, and bounds the wait with a timeout.
      listener.closeAllConnections?.();
      listener.close((closeError) => {
        if (closeError) {
          log.debug({ err: closeError }, 'race-branch listener.close reported error');
        }
      });
      if (pendingStop) {
        await pendingStop.catch(() => undefined);
      }
      throw new Error('downstream http server stopped during start');
    }

    const address = listener.address();
    if (!address || typeof address === 'string') {
      finalizeStopped();
      throw new Error('http server has no address after listen');
    }

    boundUrl = new URL(`http://${formatHost(address.address)}:${address.port}${path}`);

    for (const signal of LIFECYCLE_SIGNALS) {
      proc.on(signal, onSignal);
    }

    state = 'started';
    log.debug({ url: boundUrl.toString() }, 'downstream http server started');
  }

  function stop(): Promise<void> {
    if (pendingStop) {
      return pendingStop;
    }
    if (state === 'stopped') {
      return Promise.resolve();
    }
    if (state === 'idle') {
      // start() was never called; resolve `done` so unconditional teardown
      // patterns don't hang.
      finalizeStopped();
      return Promise.resolve();
    }
    state = 'stopping';

    pendingStop = (async () => {
      const listener = httpServer;
      httpServer = null;

      // Stop accepting new connections immediately. The `close` callback won't
      // fire until every tracked socket goes away (including long-lived SSE
      // GET streams), so we capture it now and await it after we've closed
      // the sessions that own those sockets.
      let listenerClosed: Promise<void> | null = null;
      if (listener) {
        listenerClosed = new Promise<void>((resolve) => {
          listener.close((error) => {
            if (error) {
              // Typically: listener was never listening. Either way the
              // socket isn't accepting any more.
              log.debug({ err: error }, 'listener.close reported error');
            }
            resolve();
          });
        });
      }

      // Drain finite POST/DELETE handlers. GET SSE notification streams are
      // intentionally excluded — they only end when their session closes.
      if (inFlight > 0 && listener) {
        await waitForDrain(listener, drainTimeoutMs);
      }

      // Close every session, which terminates the SSE GET streams and frees
      // the last sockets keeping the listener-close callback pending.
      const allSessions = [...sessions.values(), ...pendingSessions];
      sessions.clear();
      pendingSessions.clear();
      for (const session of allSessions) {
        try {
          await session.transport.close();
        } catch (error) {
          log.warn({ err: error }, 'error closing http session transport');
        }
        try {
          await session.server.close();
        } catch (error) {
          log.warn({ err: error }, 'error closing http session MCP server');
        }
      }

      // Bound the wait on the listener-close callback so a misbehaving client
      // (or a stuck SSE socket) can't keep `stop()` from resolving. On
      // timeout, force every remaining socket closed — `done` resolving must
      // truly mean the listening socket and its connections are gone.
      if (listener && listenerClosed) {
        await waitForListenerClose(listener, listenerClosed, drainTimeoutMs);
      }

      finalizeStopped();
    })();

    return pendingStop;
  }

  async function waitForDrain(listener: HttpListener, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      drainResolve = resolve;
      const timer = setTimeout(() => {
        if (drainResolve !== resolve) {
          return;
        }
        drainResolve = null;
        log.warn({ inFlight, timeoutMs }, 'drain timeout — forcing http connections closed');
        // Node 18.2+ exposes closeAllConnections; fall back gracefully.
        listener.closeAllConnections?.();
        resolve();
      }, timeoutMs);
      timer.unref?.();
    });
  }

  async function waitForListenerClose(
    listener: HttpListener,
    closed: Promise<void>,
    timeoutMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        log.warn({ timeoutMs }, 'listener close timeout — forcing remaining sockets closed');
        listener.closeIdleConnections?.();
        listener.closeAllConnections?.();
        // closeAllConnections triggers the close callback to fire; finish via
        // that path so any in-flight cleanup observers see a consistent
        // ordering.
      }, timeoutMs);
      timer.unref?.();
      void closed.then(finish);
    });
  }

  return {
    get url(): URL {
      if (!boundUrl) {
        throw new Error('downstream http server is not started');
      }
      return boundUrl;
    },
    start,
    stop,
    get done(): Promise<void> {
      return done;
    },
  };
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
  }
}

class RequestBodyParseError extends Error {
  constructor() {
    super('invalid JSON body');
  }
}

function readSessionIdHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers[SESSION_ID_HEADER];
  if (typeof raw === 'string') {
    return raw.trim() === '' ? undefined : raw;
  }
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
    return raw[0];
  }
  return undefined;
}

function parseRequestPath(req: IncomingMessage): string {
  const target = req.url ?? '/';
  // `req.url` may include a query string; strip it. The MCP path is matched
  // exactly so we use a fixed origin to parse without DNS lookups.
  const url = new URL(target, 'http://placeholder.invalid');
  return url.pathname;
}

function formatHost(addr: string): string {
  // IPv6 addresses must be wrapped in brackets in URLs.
  if (addr.includes(':') && !addr.startsWith('[')) {
    return `[${addr}]`;
  }
  return addr;
}

function listenOn(listener: HttpListener, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      listener.off('error', onError);
      listener.off('listening', onListening);
      listener.off('close', onClose);
    };
    const onError = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };
    const onListening = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    // If `close()` runs before listen completes (e.g. a concurrent `stop()`
    // races us mid-bind), Node may swallow both `listening` and `error`. Watch
    // `close` so the start path doesn't hang forever.
    const onClose = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error('server closed before it began listening'));
    };
    listener.once('error', onError);
    listener.once('listening', onListening);
    listener.once('close', onClose);
    listener.listen({ host, port });
  });
}
