/**
 * Per-MCP-session in-memory state for the downstream Toolbx server.
 *
 * One DownstreamSession is created per `Server` instance: stdio transports
 * have a single one for the life of the process; HTTP transports create one
 * per session id assigned by the SDK's `StreamableHTTPServerTransport`.
 *
 * `ready` flips to `true` when the client sends `notifications/initialized`.
 * Until then, request handlers (e.g. `tools/call`, `tools/list`) must reject.
 *
 * `onClose` is the canonical seam for teardown wiring. The transports and
 * runtime both register cleanups here instead of reassigning `server.onclose`
 * directly — that property is a single slot and the last writer wins, so
 * naive assignment from one site silently drops cleanups registered by
 * another. `buildToolbxMcpServer` installs the only `server.onclose` and
 * fans the event out to every registered callback.
 */
export interface DownstreamSession {
  readonly id: string;
  ready: boolean;
  /**
   * `true` when this session is a local control-plane caller (`tlbx run`) that
   * connected over loopback with the §5.3 marker. Marked sessions are exempt
   * from progressive disclosure: `tools/list` returns every enabled tool and
   * `tools/call` skips the revealed-set check. Always `false` for stdio
   * sessions and for HTTP sessions from real MCP clients.
   */
  readonly controlPlane: boolean;
  /**
   * Register a callback to fire when the SDK `Server` closes (transport
   * disconnect, explicit `server.close()`, etc). Cleanups run in
   * registration order; throws are swallowed so one cleanup cannot block
   * another. Returns an unregister function.
   */
  onClose(callback: () => void): () => void;
  /**
   * Internal — invoked by `buildToolbxMcpServer`'s `server.onclose` hook
   * to drain every registered close callback. Listed on the public type so
   * the transports can compose with it; not intended for handlers.
   */
  runCloseCallbacks(): void;
}

export function createDownstreamSession(id: string, controlPlane = false): DownstreamSession {
  const callbacks = new Set<() => void>();

  return {
    id,
    ready: false,
    controlPlane,
    onClose(callback) {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    runCloseCallbacks() {
      // Snapshot before iterating: cleanups are allowed to call their own
      // unregister fn (or another's), and mutating the set mid-iteration
      // would silently skip entries on some engines.
      const snapshot = [...callbacks];
      callbacks.clear();
      for (const callback of snapshot) {
        try {
          callback();
        } catch {
          // Cleanups must not block one another. Errors are intentionally
          // swallowed here; logging belongs to the caller.
        }
      }
    },
  };
}
