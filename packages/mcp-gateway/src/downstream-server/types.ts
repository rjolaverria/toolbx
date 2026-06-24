import type { Server as HttpListener } from 'node:http';
import type { Readable, Writable } from 'node:stream';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { Logger } from '@rjolaverria/toolbox-core';

import type { DownstreamSession } from './session.js';

/**
 * Hook seam for M2-04 / M2-05 to wire request handlers onto the SDK server.
 * Lifecycle wiring (`oninitialized`) is handled by `buildToolBoxMcpServer`
 * itself; this seam is for the application-level handlers — `tools/list`,
 * `tools/call`, and the M4 progressive-disclosure bootstrap tools — that
 * need access to the per-session state.
 */
export type RegisterDownstreamHandlers = (server: Server, session: DownstreamSession) => void;

export interface CreateDownstreamStdioServerDeps {
  logger: Logger;
  registerHandlers?: RegisterDownstreamHandlers;
  process?: NodeJS.Process;
  stdin?: Readable;
  stdout?: Writable;
}

export interface DownstreamStdioServer {
  readonly server: Server;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly done: Promise<void>;
}

export interface DownstreamHttpBinding {
  /** Loopback host. Validated upstream by the config schema. */
  host: string;
  /** Port number. `0` lets the OS pick (useful in tests). */
  port: number;
  /** Path the MCP endpoint is mounted on (must start with `/`). */
  path: string;
}

export interface CreateDownstreamHttpServerDeps {
  logger: Logger;
  http: DownstreamHttpBinding;
  registerHandlers?: RegisterDownstreamHandlers;
  process?: NodeJS.Process;
  /** Override the session id generator (tests inject a deterministic one). */
  sessionIdGenerator?: () => string;
  /**
   * Max time `stop()` waits for in-flight requests before forcing sockets
   * closed. Defaults to 5000 ms.
   */
  drainTimeoutMs?: number;
  /** Injection seam for tests; defaults to `node:http`'s `createServer`. */
  createHttpServer?: () => HttpListener;
}

export interface DownstreamHttpServer {
  /** The bound URL (host:port + path). Throws if accessed before `start()`. */
  readonly url: URL;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly done: Promise<void>;
}
