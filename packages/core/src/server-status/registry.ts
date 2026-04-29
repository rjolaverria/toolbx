import type { ServerConfig, ToolboxConfig } from '../config/schema.js';

import { assertValidTransition } from './state-machine.js';
import type { ServerStatus } from './types.js';

export type AuthStatus = 'none' | 'ok' | 'required' | 'expired';

export type ServerLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  readonly at: Date;
  readonly level: ServerLogLevel;
  readonly message: string;
}

export interface ServerStatusEntry {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly enabled: boolean;
  readonly status: ServerStatus;
  readonly authStatus: AuthStatus;
  readonly toolCount: number;
  readonly lastConnectedAt: Date | null;
  readonly lastError: { readonly message: string; readonly at: Date } | null;
  readonly recentLogs: readonly LogLine[];
}

export interface StatusRegistryUpdate {
  readonly status?: ServerStatus;
  readonly enabled?: boolean;
  readonly toolCount?: number;
}

export type StatusRegistryListener = (name: string, entry: ServerStatusEntry) => void;

export interface StatusRegistry {
  get(name: string): ServerStatusEntry | undefined;
  list(): ServerStatusEntry[];
  update(name: string, patch: StatusRegistryUpdate): ServerStatusEntry;
  appendLog(name: string, line: LogLine): ServerStatusEntry;
  subscribe(listener: StatusRegistryListener): () => void;
}

export interface CreateStatusRegistryOptions {
  /** Maximum number of recent log lines retained per server. Default: 100. */
  recentLogsLimit?: number;
  /** Test seam: override clock used to stamp `lastError.at`. */
  now?: () => Date;
}

export class UnknownServerError extends Error {
  override readonly name = 'UnknownServerError';
  readonly serverName: string;

  constructor(serverName: string) {
    super(`unknown server: ${serverName}`);
    this.serverName = serverName;
  }
}

const DEFAULT_RECENT_LOGS_LIMIT = 100;

function deriveAuthStatus(server: ServerConfig, status: ServerStatus): AuthStatus {
  switch (status.kind) {
    case 'auth_required':
      return 'required';
    case 'auth_expired':
      return 'expired';
    case 'connected':
      if (server.type === 'http' && server.auth !== undefined && server.auth.type !== 'none') {
        return 'ok';
      }
      return 'none';
    default:
      return 'none';
  }
}

function initialStatus(server: ServerConfig): ServerStatus {
  return server.enabled ? { kind: 'stopped' } : { kind: 'disabled' };
}

function makeInitialEntry(name: string, server: ServerConfig): ServerStatusEntry {
  const status = initialStatus(server);
  return {
    name,
    transport: server.type,
    enabled: server.enabled,
    status,
    authStatus: deriveAuthStatus(server, status),
    toolCount: 0,
    lastConnectedAt: null,
    lastError: null,
    recentLogs: [],
  };
}

export function createStatusRegistry(
  initialConfig: ToolboxConfig,
  options: CreateStatusRegistryOptions = {},
): StatusRegistry {
  const recentLogsLimit = options.recentLogsLimit ?? DEFAULT_RECENT_LOGS_LIMIT;
  if (!Number.isInteger(recentLogsLimit) || recentLogsLimit < 1) {
    throw new RangeError('recentLogsLimit must be a positive integer');
  }
  const now = options.now ?? ((): Date => new Date());

  const entries = new Map<string, ServerStatusEntry>();
  const servers = new Map<string, ServerConfig>();
  const listeners = new Set<StatusRegistryListener>();

  for (const [name, server] of Object.entries(initialConfig.servers)) {
    servers.set(name, server);
    entries.set(name, makeInitialEntry(name, server));
  }

  function notify(name: string, entry: ServerStatusEntry): void {
    for (const listener of listeners) {
      try {
        listener(name, entry);
      } catch {
        // Listeners must not be able to break the registry. Swallow.
      }
    }
  }

  function requireEntry(name: string): { entry: ServerStatusEntry; server: ServerConfig } {
    const entry = entries.get(name);
    const server = servers.get(name);
    if (entry === undefined || server === undefined) {
      throw new UnknownServerError(name);
    }
    return { entry, server };
  }

  function update(name: string, patch: StatusRegistryUpdate): ServerStatusEntry {
    const { entry, server } = requireEntry(name);

    let nextStatus = entry.status;
    if (patch.status !== undefined) {
      assertValidTransition(entry.status, patch.status);
      nextStatus = patch.status;
    }

    const nextEnabled = patch.enabled ?? entry.enabled;
    if (patch.toolCount !== undefined) {
      if (!Number.isInteger(patch.toolCount) || patch.toolCount < 0) {
        throw new RangeError(
          `toolCount must be a non-negative integer; received ${String(patch.toolCount)}`,
        );
      }
    }
    const nextToolCount = patch.toolCount ?? entry.toolCount;

    let nextLastConnectedAt = entry.lastConnectedAt;
    if (patch.status !== undefined && patch.status.kind === 'connected') {
      nextLastConnectedAt = patch.status.since;
    }

    let nextLastError = entry.lastError;
    if (patch.status !== undefined && patch.status.kind === 'error') {
      nextLastError = { message: patch.status.error.message, at: now() };
    }

    const nextEntry: ServerStatusEntry = {
      name: entry.name,
      transport: entry.transport,
      enabled: nextEnabled,
      status: nextStatus,
      authStatus: deriveAuthStatus(server, nextStatus),
      toolCount: nextToolCount,
      lastConnectedAt: nextLastConnectedAt,
      lastError: nextLastError,
      recentLogs: entry.recentLogs,
    };

    entries.set(name, nextEntry);
    notify(name, nextEntry);
    return nextEntry;
  }

  function appendLog(name: string, line: LogLine): ServerStatusEntry {
    const { entry } = requireEntry(name);
    const next = [...entry.recentLogs, line];
    const trimmed =
      next.length > recentLogsLimit ? next.slice(next.length - recentLogsLimit) : next;
    const nextEntry: ServerStatusEntry = { ...entry, recentLogs: trimmed };
    entries.set(name, nextEntry);
    notify(name, nextEntry);
    return nextEntry;
  }

  function get(name: string): ServerStatusEntry | undefined {
    return entries.get(name);
  }

  function list(): ServerStatusEntry[] {
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function subscribe(listener: StatusRegistryListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { get, list, update, appendLog, subscribe };
}
