import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { Logger } from '@toolbox/core';

import type { DownstreamSession } from './session.js';

/**
 * Per-session debounce window for `notifications/tools/list_changed`. A flurry
 * of changes (e.g. `reveal_tools` adding ten exposed names in one call, or an
 * upstream reconnect populating its tool list) coalesces into a single
 * notification per window, matching the M4-06 acceptance criterion.
 */
export const TOOLS_LIST_CHANGED_DEBOUNCE_MS = 50;

export interface ToolsChangedNotifierScheduler {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface CreateToolsChangedNotifierDeps {
  /** SDK MCP server bound to a single downstream session. */
  server: Server;
  /** Per-session state used to gate notifications on `notifications/initialized`. */
  session: DownstreamSession;
  /** Optional logger; warnings about a failed send go here. */
  logger?: Logger;
  /** Override the debounce window. Tests pin this to 0 or a fake clock. */
  debounceMs?: number;
  /** Test seam for timers. Defaults to `globalThis.setTimeout` / `clearTimeout`. */
  scheduler?: ToolsChangedNotifierScheduler;
}

export interface ToolsChangedNotifier {
  /**
   * Request a `notifications/tools/list_changed` to fire for this session.
   * Multiple calls within the debounce window collapse into a single send.
   * Calls after `dispose()` are ignored.
   */
  schedule(): void;
  /** Cancel any pending send and refuse future schedules. Idempotent. */
  dispose(): void;
}

const defaultScheduler: ToolsChangedNotifierScheduler = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/**
 * Build a debounced notifier that pushes `notifications/tools/list_changed`
 * to the calling session through the SDK `Server`. The notifier is the single
 * funnel through which M4-06 emits visibility-change notifications: per-session
 * visibility events and global tool-registry events both call `schedule()`,
 * and the debouncer collapses bursts into one send per window.
 *
 * The notifier never sends before the session has finished initialising
 * (`notifications/initialized` flips `session.ready`). The MCP SDK rejects
 * notifications on a transport that isn't connected yet, and the spec
 * forbids `tools/list_changed` before initialization in any case — the
 * client will get the up-to-date list on its first `tools/list` after the
 * handshake.
 */
export function createToolsChangedNotifier(
  deps: CreateToolsChangedNotifierDeps,
): ToolsChangedNotifier {
  const debounceMs = deps.debounceMs ?? TOOLS_LIST_CHANGED_DEBOUNCE_MS;
  const scheduler = deps.scheduler ?? defaultScheduler;
  let timer: unknown = null;
  let disposed = false;

  function clearTimer(): void {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  }

  function fire(): void {
    timer = null;
    if (disposed) {
      return;
    }
    if (!deps.session.ready) {
      return;
    }
    deps.server.sendToolListChanged().catch((err: unknown) => {
      deps.logger?.warn(
        { err, sessionId: deps.session.id },
        'failed to send tools/list_changed notification',
      );
    });
  }

  return {
    schedule() {
      if (disposed) {
        return;
      }
      if (timer !== null) {
        return;
      }
      timer = scheduler.setTimeout(fire, debounceMs);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimer();
    },
  };
}
