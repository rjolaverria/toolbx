import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { formatExposedName, type NamespaceOptions, type ServerStatus } from '@toolbox/core';

/**
 * In-memory registry of upstream tools, keyed by server. Aggregates the
 * `tools/list` results from each upstream session and projects them into
 * namespaced exposed tools for the downstream `tools/list` handler (M2-04).
 *
 * The registry is a passive data structure. Wiring — subscribing to upstream
 * sessions' `tools_list_changed` events, mirroring server status changes,
 * and removing servers on config edits — lives in `createGatewayRuntime`
 * (`../runtime/runtime.ts`), which `tlbx serve` and other gateway entry
 * points instantiate. Tests for M2-04 drive the registry directly.
 *
 * Servers in `disabled`, `error`, `auth_required`, `stopped`, or `starting`
 * status do not contribute tools. `connected` contributes, and so does
 * `auth_expired`: its tools stay published so the agent can still call them
 * (each call returns a structured re-auth message) and `routeToolCall` can
 * reach the session to drive next-call recovery (F1-21, SPECS §4.6.2).
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
  /**
   * O(1) lookup of a visible tool by its exposed (namespaced) name. Returns
   * `undefined` for unknown names and for tools whose owning server is not
   * currently visible (disabled, disconnected, etc.). `tools/call` uses this
   * so each call avoids the `list()` allocation + sort.
   */
  find(exposedName: string): RegisteredTool | undefined;
  subscribe(listener: () => void): () => void;
}

interface InternalEntry {
  readonly serverName: string;
  readonly status: ServerStatus;
  readonly enabled: boolean;
  readonly tools: readonly RegisteredTool[];
  /**
   * Stable serialization of the visible tool set, used to decide whether
   * `setServerEntry` calls warrant a `notify()`. Captures every field of the
   * exposed `Tool` (name, description, inputSchema, annotations, …) so a
   * metadata-only change still fires subscribers, and is computed from a
   * sorted copy so input-order churn from upstream does not.
   */
  readonly fingerprint: string;
}

function isServerVisible(entry: InternalEntry): boolean {
  return (
    entry.enabled && (entry.status.kind === 'connected' || entry.status.kind === 'auth_expired')
  );
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

function fingerprintTools(tools: readonly RegisteredTool[]): string {
  // Sort by exposedName (byte order) so identical sets in different upstream
  // orders fingerprint identically. Comparator must return 0 on equality to
  // honour the Array.prototype.sort contract.
  const sorted = [...tools].sort((a, b) => {
    if (a.exposedName < b.exposedName) {
      return -1;
    }
    if (a.exposedName > b.exposedName) {
      return 1;
    }
    return 0;
  });
  return JSON.stringify(sorted.map((t) => t.tool));
}

function entriesEqualForVisibility(prev: InternalEntry, next: InternalEntry): boolean {
  // If neither was visible before nor after, the visible-tool set is unchanged
  // regardless of enabled flips, status churn (e.g. starting → error during
  // reconnect), or the upstream tool list contents.
  if (!isServerVisible(prev) && !isServerVisible(next)) {
    return true;
  }
  if (isServerVisible(prev) !== isServerVisible(next)) {
    return false;
  }
  return prev.fingerprint === next.fingerprint;
}

export interface CreateToolRegistryOptions {
  namespacing: NamespaceOptions;
}

export function createToolRegistry(options: CreateToolRegistryOptions): ToolRegistry {
  const entries = new Map<string, InternalEntry>();
  // Mirrors the visible subset of `entries` keyed by exposedName for O(1)
  // lookup from `find()`. Kept in sync inside `setServerEntry` /
  // `removeServer`; only visible servers contribute keys.
  const visibleByExposedName = new Map<string, RegisteredTool>();
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

  function dropFromIndex(entry: InternalEntry): void {
    if (!isServerVisible(entry)) {
      return;
    }
    for (const tool of entry.tools) {
      visibleByExposedName.delete(tool.exposedName);
    }
  }

  function addToIndex(entry: InternalEntry): void {
    if (!isServerVisible(entry)) {
      return;
    }
    for (const tool of entry.tools) {
      visibleByExposedName.set(tool.exposedName, tool);
    }
  }

  function setServerEntry(entry: ServerToolEntry): void {
    const tools = buildRegisteredTools(entry.serverName, entry.tools, options.namespacing);
    const next: InternalEntry = {
      serverName: entry.serverName,
      status: entry.status,
      enabled: entry.enabled,
      tools,
      fingerprint: fingerprintTools(tools),
    };
    const prev = entries.get(entry.serverName);
    if (prev !== undefined) {
      dropFromIndex(prev);
    }
    addToIndex(next);
    entries.set(entry.serverName, next);
    // First insert of a non-visible server doesn't change the exposed set
    // (empty before, empty after), so skip notify(). For existing entries,
    // delegate to entriesEqualForVisibility.
    if (prev === undefined ? isServerVisible(next) : !entriesEqualForVisibility(prev, next)) {
      notify();
    }
  }

  function removeServer(serverName: string): void {
    const prev = entries.get(serverName);
    if (prev === undefined) {
      return;
    }
    dropFromIndex(prev);
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
    // Use byte-order comparison (not `localeCompare`) so the sort is
    // deterministic across machines/runtimes irrespective of process locale.
    visible.sort((a, b) => {
      if (a.serverName !== b.serverName) {
        return a.serverName < b.serverName ? -1 : 1;
      }
      if (a.upstreamName === b.upstreamName) {
        return 0;
      }
      return a.upstreamName < b.upstreamName ? -1 : 1;
    });
    return visible;
  }

  function find(exposedName: string): RegisteredTool | undefined {
    return visibleByExposedName.get(exposedName);
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { setServerEntry, removeServer, list, find, subscribe };
}
