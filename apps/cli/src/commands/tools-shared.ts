import * as path from 'node:path';

import {
  parseExposedName,
  readToolCache,
  resolveToolCachePath,
  ToolCacheError,
  ToolCacheMissingError,
  type NamespacingConfig,
  type ToolBoxConfig,
} from '@toolbox/core';

import type { ServerCommandDeps } from './server-shared.js';

export interface ToolsCommandDeps extends ServerCommandDeps {
  /** Resolves the tool cache path for the resolved config path. Tests inject a fixture path. */
  resolveCachePath: (configPath: string) => string;
}

export function defaultResolveCachePath(configPath: string): string {
  return path.join(path.dirname(configPath), path.basename(resolveToolCachePath()));
}

export interface ToolView {
  exposedName: string;
  serverName: string;
  upstreamName: string;
  enabled: boolean;
  /** Where the listing data came from (the gateway cache vs. config synthesis). */
  source: 'cache' | 'config';
  /** Whether the tool is a proxied upstream tool or an imported custom tool (P3-05). */
  toolSource: 'upstream' | 'custom';
}

export type LoadToolsResult =
  | { kind: 'ok'; tools: ToolView[]; source: 'cache'; updatedAt: string }
  | { kind: 'ok'; tools: ToolView[]; source: 'config' }
  | { kind: 'error' };

export interface LoadToolsOptions {
  fromConfig?: boolean;
  serverFilter?: string;
}

/**
 * Resolves the tool inventory for `tlbx tools list` / `search`.
 *
 * Default — read the cached registry the gateway persists during `tlbx serve`.
 * `--from-config` — synthesize a config-only view: every server present in
 * config is reported with no tools, and the listing is empty. Useful when
 * the gateway has never run.
 *
 * Returns `kind: 'error'` and writes a human-readable message to `stderr`
 * after a recoverable failure (missing cache, parse error, missing config).
 * The caller exits non-zero.
 */
export async function loadTools(
  config: ToolBoxConfig,
  configPath: string,
  options: LoadToolsOptions,
  deps: ToolsCommandDeps,
): Promise<LoadToolsResult> {
  if (options.fromConfig === true) {
    // No tool data without a cache; we can only enumerate what the user has
    // configured. The list is therefore empty and reports the configured
    // surface — useful as a "what would I see" hint.
    return { kind: 'ok', tools: [], source: 'config' };
  }

  const cachePath = deps.resolveCachePath(configPath);
  let cache;
  try {
    cache = await readToolCache(cachePath);
  } catch (error) {
    if (error instanceof ToolCacheMissingError) {
      deps.stderr(
        `${error.message} ` +
          `Run \`tlbx serve\` once so ToolBox can populate the registry, ` +
          `or pass \`--from-config\` to list only the configured servers.\n`,
      );
      return { kind: 'error' };
    }
    if (error instanceof ToolCacheError) {
      deps.stderr(`${error.message}\n`);
      return { kind: 'error' };
    }
    throw error;
  }

  const tools = cache.tools
    .filter(
      (entry) => options.serverFilter === undefined || entry.serverName === options.serverFilter,
    )
    .map(
      (entry): ToolView => ({
        exposedName: entry.exposedName,
        serverName: entry.serverName,
        upstreamName: entry.upstreamName,
        enabled: config.tools[entry.exposedName]?.enabled !== false,
        source: 'cache',
        toolSource: entry.source,
      }),
    )
    .sort((a, b) => {
      if (a.serverName !== b.serverName) {
        return a.serverName < b.serverName ? -1 : 1;
      }
      if (a.upstreamName === b.upstreamName) {
        return 0;
      }
      return a.upstreamName < b.upstreamName ? -1 : 1;
    });

  return { kind: 'ok', tools, source: 'cache', updatedAt: cache.updatedAt };
}

export interface ParsedToolReference {
  exposedName: string;
  serverName: string;
  upstreamName: string;
}

export class ToolReferenceError extends Error {
  override readonly name = 'ToolReferenceError';
}

/**
 * Accepts both `namespace/tool` (per SPECS §4.2 and the user-facing
 * docs/help) and the wire-level `namespace__tool` form.
 *
 * The slash form is unambiguous — the namespace ends at the first `/` — so
 * upstream tool names that legitimately contain the namespacing separator
 * (e.g. `github/create__issue`, where `create__issue` is the upstream name)
 * are accepted. Server names that contain the separator are rejected at
 * config load (`ServerNameSchema`); the same constraint is enforced here so
 * a slash reference like `foo__bar/baz` cannot smuggle one in via the CLI.
 *
 * The `__` form delegates to `parseExposedName`, which splits on the first
 * separator — so `github__create__issue` parses as server `github`, tool
 * `create__issue` (matching the gateway's exposed-name parsing).
 */
export function parseToolReference(
  raw: string,
  namespacing: NamespacingConfig,
): ParsedToolReference {
  if (raw.length === 0) {
    throw new ToolReferenceError('tool reference is empty');
  }
  const slashIdx = raw.indexOf('/');
  if (slashIdx >= 0) {
    if (raw.indexOf('/', slashIdx + 1) >= 0) {
      throw new ToolReferenceError(
        `tool reference "${raw}" contains more than one \`/\`; expected \`namespace/tool\``,
      );
    }
    const serverName = raw.slice(0, slashIdx);
    const upstreamName = raw.slice(slashIdx + 1);
    if (serverName.length === 0 || upstreamName.length === 0) {
      throw new ToolReferenceError(
        `tool reference "${raw}" must be \`namespace/tool\` with non-empty parts`,
      );
    }
    if (serverName.includes(namespacing.separator)) {
      throw new ToolReferenceError(
        `tool reference "${raw}" has a namespace containing the \`${namespacing.separator}\` separator; server names cannot contain it`,
      );
    }
    return {
      exposedName: `${serverName}${namespacing.separator}${upstreamName}`,
      serverName,
      upstreamName,
    };
  }

  const parsed = parseExposedName(raw, namespacing);
  if (parsed === null) {
    throw new ToolReferenceError(
      `tool reference "${raw}" must be \`namespace/tool\` or \`namespace${namespacing.separator}tool\``,
    );
  }
  return {
    exposedName: raw,
    serverName: parsed.serverName,
    upstreamName: parsed.upstreamName,
  };
}
