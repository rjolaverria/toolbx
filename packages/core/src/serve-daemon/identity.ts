import { createHash } from 'node:crypto';

import type { ToolBoxConfig } from '../config/schema.js';

/**
 * Serializes a value to JSON with object keys sorted recursively, so two
 * configs that differ only by key order or formatting produce identical text.
 * Arrays keep their order (it is significant in config, e.g. `args`).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

/**
 * A stable fingerprint of a loaded config, used to detect that a long-lived
 * daemon was started with a config that has since drifted from the file on
 * disk. A reused daemon keeps serving its startup config snapshot (per-tool
 * enable flags, server set, auth types), so a consumer that read a newer file
 * would otherwise act on state the daemon does not share. Comparing this
 * fingerprint lets the consumer refuse a stale daemon instead.
 *
 * The hash is taken over a canonical (key-sorted) JSON form so cosmetic edits
 * — reordered keys, whitespace — do not force a needless restart, while any
 * semantic change does.
 */
export function computeConfigIdentity(config: ToolBoxConfig): string {
  const canonical = JSON.stringify(canonicalize(config));
  return createHash('sha256').update(canonical).digest('hex');
}
