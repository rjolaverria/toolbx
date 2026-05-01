import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { formatExposedName, type NamespaceOptions, type ServerStatus } from '@toolbox/core';

/**
 * In-memory registry of upstream tools, keyed by server. Aggregates the
 * `tools/list` results from each upstream session and projects them into
 * namespaced exposed tools for the downstream `tools/list` handler (M2-04).
 *
 * The registry is a passive data structure. Wiring (subscribing to upstream
 * sessions' `tools_list_changed` events, mirroring server status changes,
 * removing servers on config edits) lives in the gateway entry point —
 * M2-06's `tlbx serve` will install the listeners. Tests for M2-04 drive
 * the registry directly.
 *
 * Servers in `disabled`, `error`, `auth_required`, `auth_expired`, `stopped`,
 * or `starting` status do not contribute tools. Only `connected` does.
 */

export interface RegisteredTool {
  readonly exposedName: string;
  readonly serverName: string;
  readonly upstreamName: string;
  readonly tool: Tool;
}

export interface ServerToolEntry {
  readonly serverName: string;
  readonly status: ServerStatus;
  readonly enabled: boolean;
  readonly tools: readonly Tool[];
}

export interface ToolRegistry {
  setServerEntry(entry: ServerToolEntry): void;
  removeServer(serverName: string): void;
  list(): RegisteredTool[];
  subscribe(listener: () => void): () => void;
}

interface InternalEntry {
  readonly serverName: string;
  readonly status: ServerStatus;
  readonly enabled: boolean;
  readonly tools: readonly RegisteredTool[];
}

function isServerVisible(entry: InternalEntry): boolean {
  return entry.enabled && entry.status.kind === 'connected';
}

function buildRegisteredTools(
  serverName: string,
  upstreamTools: readonly Tool[],
  options: NamespaceOptions,
): RegisteredTool[] {
  return upstreamTools.map((tool) => ({
    exposedName: formatExposedName(serverName, tool.name, options),
    serverName,
    upstreamName: tool.name,
    tool: { ...tool, name: formatExposedName(serverName, tool.name, options) },
  }));
}

function entriesEqualForVisibility(prev: InternalEntry, next: InternalEntry): boolean {
  if (prev.enabled !== next.enabled) {
    return false;
  }
  if (prev.status.kind !== next.status.kind) {
    return false;
  }
  // If neither was visible before nor after, the visible-tool set is unchanged
  // regardless of the upstream tool list contents.
  if (!isServerVisible(prev) && !isServerVisible(next)) {
    return true;
  }
  if (prev.tools.length !== next.tools.length) {
    return false;
  }
  for (let i = 0; i < prev.tools.length; i += 1) {
    const a = prev.tools[i];
    const b = next.tools[i];
    if (a === undefined || b === undefined || a.exposedName !== b.exposedName) {
      return false;
    }
  }
  return true;
}

export interface CreateToolRegistryOptions {
  namespacing: NamespaceOptions;
}

export function createToolRegistry(options: CreateToolRegistryOptions): ToolRegistry {
  const entries = new Map<string, InternalEntry>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Listeners must not be able to break the registry.
      }
    }
  }

  function setServerEntry(entry: ServerToolEntry): void {
    const next: InternalEntry = {
      serverName: entry.serverName,
      status: entry.status,
      enabled: entry.enabled,
      tools: buildRegisteredTools(entry.serverName, entry.tools, options.namespacing),
    };
    const prev = entries.get(entry.serverName);
    entries.set(entry.serverName, next);
    if (prev === undefined || !entriesEqualForVisibility(prev, next)) {
      notify();
    }
  }

  function removeServer(serverName: string): void {
    const prev = entries.get(serverName);
    if (prev === undefined) {
      return;
    }
    entries.delete(serverName);
    if (isServerVisible(prev)) {
      notify();
    }
  }

  function list(): RegisteredTool[] {
    const visible: RegisteredTool[] = [];
    for (const entry of entries.values()) {
      if (!isServerVisible(entry)) {
        continue;
      }
      for (const tool of entry.tools) {
        visible.push(tool);
      }
    }
    visible.sort((a, b) => {
      const byServer = a.serverName.localeCompare(b.serverName);
      if (byServer !== 0) {
        return byServer;
      }
      return a.upstreamName.localeCompare(b.upstreamName);
    });
    return visible;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { setServerEntry, removeServer, list, subscribe };
}
