import type { NamespacingConfig } from '../config/schema.js';

/**
 * Pure namespacing module. Converts between upstream `(serverName, upstreamName)`
 * pairs and the namespaced names Toolbx exposes downstream, and detects
 * collisions when two upstream servers would expose the same name.
 *
 * Phase 1 only supports `separator: '__'` and `format: 'server__tool'`. Other
 * values are rejected at config load (schema validation in `@toolbx/core`)
 * and re-checked here so callers that bypass the schema can't slip past.
 *
 * Server names containing the separator are rejected at config load
 * (see `ServerNameSchema`); without that guarantee `parseExposedName` cannot
 * round-trip uniquely.
 */

export type NamespaceOptions = Pick<NamespacingConfig, 'separator' | 'format'>;

const SUPPORTED_SEPARATOR = '__';
const SUPPORTED_FORMAT = 'server__tool';

export class UnsupportedNamespacingOptionError extends Error {
  override readonly name = 'UnsupportedNamespacingOptionError';
  readonly option: 'separator' | 'format';
  readonly value: string;

  constructor(option: 'separator' | 'format', value: string) {
    super(
      `unsupported namespacing ${option}: ${JSON.stringify(value)} (Phase 1 only supports ${
        option === 'separator' ? SUPPORTED_SEPARATOR : SUPPORTED_FORMAT
      })`,
    );
    this.option = option;
    this.value = value;
  }
}

function assertSupported(options: NamespaceOptions): void {
  if (options.separator !== SUPPORTED_SEPARATOR) {
    throw new UnsupportedNamespacingOptionError('separator', options.separator);
  }
  if (options.format !== SUPPORTED_FORMAT) {
    throw new UnsupportedNamespacingOptionError('format', options.format);
  }
}

export function formatExposedName(
  serverName: string,
  upstreamName: string,
  options: NamespaceOptions,
): string {
  assertSupported(options);
  return `${serverName}${options.separator}${upstreamName}`;
}

export interface ParsedExposedName {
  readonly serverName: string;
  readonly upstreamName: string;
}

export function parseExposedName(
  exposedName: string,
  options: NamespaceOptions,
): ParsedExposedName | null {
  assertSupported(options);
  const idx = exposedName.indexOf(options.separator);
  if (idx <= 0) {
    return null;
  }
  const serverName = exposedName.slice(0, idx);
  const upstreamName = exposedName.slice(idx + options.separator.length);
  if (upstreamName.length === 0) {
    return null;
  }
  return { serverName, upstreamName };
}

export interface NamespaceCollision {
  readonly exposedName: string;
  readonly sources: readonly { readonly serverName: string; readonly upstreamName: string }[];
}

/**
 * Detects upstream tools that would resolve to the same namespaced exposed
 * name.
 *
 * With the supported `server__tool` format and validated server names,
 * distinct `(serverName, upstreamName)` pairs do not collide. In practice,
 * collisions can still be reported when an upstream server returns duplicate
 * tool names for the same server, or when callers provide invalid /
 * unvalidated input that violates those assumptions. The function groups by
 * exposed name defensively so callers can surface those conflicts.
 */
export function detectCollisions(
  toolsByServer: Readonly<Record<string, readonly string[]>>,
  options: NamespaceOptions,
): NamespaceCollision[] {
  assertSupported(options);
  const buckets = new Map<string, { serverName: string; upstreamName: string }[]>();
  for (const [serverName, upstreamNames] of Object.entries(toolsByServer)) {
    for (const upstreamName of upstreamNames) {
      const exposedName = formatExposedName(serverName, upstreamName, options);
      const list = buckets.get(exposedName);
      if (list) {
        list.push({ serverName, upstreamName });
      } else {
        buckets.set(exposedName, [{ serverName, upstreamName }]);
      }
    }
  }
  const collisions: NamespaceCollision[] = [];
  for (const [exposedName, sources] of buckets) {
    if (sources.length > 1) {
      collisions.push({ exposedName, sources });
    }
  }
  collisions.sort((a, b) => a.exposedName.localeCompare(b.exposedName));
  return collisions;
}
