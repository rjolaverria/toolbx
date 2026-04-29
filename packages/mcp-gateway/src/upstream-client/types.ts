import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export type ListToolsResult = Awaited<ReturnType<Client['listTools']>>;
export type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

export interface UpstreamCallToolOptions {
  /** Per-call timeout in milliseconds. Falls back to the server config timeout. */
  timeoutMs?: number;
  /** Abort signal — if aborted before the call resolves, the call rejects. */
  signal?: AbortSignal;
}

export interface UpstreamLogEntry {
  level: 'debug';
  message: string;
}

export interface UpstreamExitInfo {
  /** Whether the process exited because we explicitly disconnected. */
  intentional: boolean;
}

export interface UpstreamClientEvents {
  tools_list_changed: () => void;
  log: (entry: UpstreamLogEntry) => void;
  exit: (info: UpstreamExitInfo) => void;
}

export type UpstreamClientEvent = keyof UpstreamClientEvents;

export interface UpstreamClient {
  readonly serverName: string | undefined;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  listTools(): Promise<ListToolsResult>;
  callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    opts?: UpstreamCallToolOptions,
  ): Promise<CallToolResult>;
  ping(): Promise<void>;

  on<E extends UpstreamClientEvent>(event: E, handler: UpstreamClientEvents[E]): void;
  off<E extends UpstreamClientEvent>(event: E, handler: UpstreamClientEvents[E]): void;
}
