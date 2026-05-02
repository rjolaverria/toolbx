/**
 * Per-MCP-session record of which exposed tools the current downstream client
 * has revealed. Powers M4 progressive disclosure:
 *
 * - `tools/list` (M4-07) filters its output through `isVisible` / `snapshot`.
 * - The reveal/hide bootstrap tools (M4-04) call `reveal` / `hide`.
 * - `notifications/tools/list_changed` (M4-06) subscribes to the `change`
 *   event emitted on every actual visibility change.
 *
 * Note: `progressiveDisclosure.autoRevealExactServerMatches` from the config
 * schema is *enforced by callers* (M4-03's `search_tools`), not by this
 * module. M4-03 reads the flag, detects an exact server-name match, and calls
 * `reveal()` here with the server's tool list. Keeping that logic in the
 * caller avoids coupling this module to the registry of upstream tools.
 */

const BOOTSTRAP_REVEAL_REASON = 'reveal' as const;
const BOOTSTRAP_HIDE_REASON = 'hide' as const;
const BOOTSTRAP_RESET_REASON = 'reset' as const;

export type VisibilityMode = 'session' | 'global';

export interface SessionVisibilityOptions {
  readonly mode: VisibilityMode;
  /**
   * Exposed names that must always report as visible regardless of state.
   * Callers pass the canonical bootstrap tool list (e.g. when
   * `progressiveDisclosure.bootstrapTools` is `true`); pass an empty array or
   * omit when bootstrap tools are disabled.
   */
  readonly bootstrapToolNames?: readonly string[];
}

export type SessionVisibilityChangeReason =
  | { readonly kind: typeof BOOTSTRAP_REVEAL_REASON; readonly added: readonly string[] }
  | { readonly kind: typeof BOOTSTRAP_HIDE_REASON; readonly removed: readonly string[] }
  | { readonly kind: typeof BOOTSTRAP_RESET_REASON };

export type SessionVisibilityChangeListener = (reason: SessionVisibilityChangeReason) => void;

export interface SessionVisibility {
  /** Names currently revealed. Bootstrap tools are not included. */
  list(): string[];
  /**
   * Bootstrap tool names plus revealed names, deduplicated and sorted by byte
   * order (matches the ordering used by `searchTools`).
   */
  snapshot(): string[];
  /**
   * Mark exposed names visible. Returns the names that were newly added to
   * the revealed set (already-visible and bootstrap names are skipped). Emits
   * a single `change` event when at least one name is added.
   */
  reveal(names: readonly string[]): string[];
  /**
   * Remove exposed names from the revealed set. Returns the names that were
   * actually removed. Bootstrap tools cannot be hidden and are silently
   * skipped. Emits a single `change` event when at least one name is removed.
   */
  hide(names: readonly string[]): string[];
  /** True for bootstrap tools or any name in the revealed set. */
  isVisible(exposedName: string): boolean;
  /** Empty the revealed set. Emits a single `change` event when non-empty. */
  reset(): void;
  /** Subscribe to revealed-set changes. Returns an unsubscribe function. */
  on(event: 'change', listener: SessionVisibilityChangeListener): () => void;
}

interface VisibilityState {
  readonly revealed: Set<string>;
  readonly listeners: Set<SessionVisibilityChangeListener>;
}

// Single shared state for `mode: 'global'`. Created lazily on first use so
// `mode: 'session'` consumers don't pay for it.
let globalState: VisibilityState | null = null;

function getGlobalState(): VisibilityState {
  if (globalState === null) {
    globalState = { revealed: new Set<string>(), listeners: new Set() };
  }
  return globalState;
}

function notify(state: VisibilityState, reason: SessionVisibilityChangeReason): void {
  for (const listener of state.listeners) {
    try {
      listener(reason);
    } catch {
      // Listeners must not be able to break the registry. Swallow.
    }
  }
}

function sortByByteOrder(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  });
}

export function createSessionVisibility(options: SessionVisibilityOptions): SessionVisibility {
  const bootstrapNames = new Set(options.bootstrapToolNames ?? []);
  const state: VisibilityState =
    options.mode === 'global'
      ? getGlobalState()
      : { revealed: new Set<string>(), listeners: new Set() };

  function isVisible(exposedName: string): boolean {
    return bootstrapNames.has(exposedName) || state.revealed.has(exposedName);
  }

  function list(): string[] {
    // Filter against this instance's bootstrap allowlist: in `mode: 'global'`,
    // another instance with a different allowlist may have stored a name into
    // the shared revealed set that is bootstrap for *this* instance. The
    // contract says bootstrap tools are not included in `list()`.
    const filtered: string[] = [];
    for (const name of state.revealed) {
      if (!bootstrapNames.has(name)) {
        filtered.push(name);
      }
    }
    return sortByByteOrder(filtered);
  }

  function snapshot(): string[] {
    const merged = new Set<string>(bootstrapNames);
    for (const name of state.revealed) {
      merged.add(name);
    }
    return sortByByteOrder(merged);
  }

  function reveal(names: readonly string[]): string[] {
    const added: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      if (bootstrapNames.has(name) || state.revealed.has(name)) {
        continue;
      }
      state.revealed.add(name);
      added.push(name);
    }
    if (added.length > 0) {
      notify(state, { kind: BOOTSTRAP_REVEAL_REASON, added });
    }
    return added;
  }

  function hide(names: readonly string[]): string[] {
    const removed: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      if (bootstrapNames.has(name)) {
        continue;
      }
      if (state.revealed.delete(name)) {
        removed.push(name);
      }
    }
    if (removed.length > 0) {
      notify(state, { kind: BOOTSTRAP_HIDE_REASON, removed });
    }
    return removed;
  }

  function reset(): void {
    if (state.revealed.size === 0) {
      return;
    }
    state.revealed.clear();
    notify(state, { kind: BOOTSTRAP_RESET_REASON });
  }

  function on(_event: 'change', listener: SessionVisibilityChangeListener): () => void {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }

  return { list, snapshot, reveal, hide, isVisible, reset, on };
}

/**
 * Test seam — drops the module-level `mode: 'global'` state so unit tests can
 * run in isolation. Not part of the public API.
 *
 * @internal
 */
export function __resetGlobalVisibilityForTests(): void {
  globalState = null;
}
