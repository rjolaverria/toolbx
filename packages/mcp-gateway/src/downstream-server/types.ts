import type { Readable, Writable } from 'node:stream';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { Logger } from '@toolbox/core';

/**
 * Hook seam for M2-03 / M2-04 / M2-05 to wire request handlers onto the SDK
 * server. M2-01 only delivers the lifecycle scaffold; the protocol handlers
 * (initialize, ping, tools/list, tools/call) plug in here.
 */
export type RegisterDownstreamHandlers = (server: Server) => void;

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
