import {
  Command,
  InvalidArgumentError,
  type CommandUnknownOpts,
} from '@commander-js/extra-typings';

import {
  readToolCache,
  searchTools,
  ToolCacheError,
  ToolCacheMissingError,
  type RegisteredToolView,
  type SearchMatchedField,
} from '@rjolaverria/toolbox-core';

import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  parsePositiveInt,
  resolveTargetPath,
} from './server-shared.js';
import {
  defaultResolveCachePath,
  reconcileCachedTool,
  readCustomManifestMap,
  type ToolsCommandDeps,
} from './tools-shared.js';

export interface ToolsSearchOptions {
  config?: string;
  json?: true;
  limit?: number;
}

interface ResultRow {
  exposedName: string;
  serverName: string;
  upstreamName: string;
  enabled: boolean;
  source: 'upstream' | 'custom';
  score: number;
  matchedFields: readonly SearchMatchedField[];
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return value + ' '.repeat(width - value.length);
}

function formatTable(rows: readonly ResultRow[]): string {
  if (rows.length === 0) {
    return 'No matches.\n';
  }
  const headers = ['EXPOSED', 'SERVER', 'TOOL', 'ENABLED', 'SOURCE', 'SCORE', 'MATCHED'];
  const cells = rows.map((row) => [
    row.exposedName,
    row.serverName,
    row.upstreamName,
    row.enabled ? 'yes' : 'no',
    row.source,
    String(row.score),
    row.matchedFields.join(','),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((cell) => (cell[i] ?? '').length)),
  );
  const lines: string[] = [];
  lines.push(headers.map((h, i) => pad(h, widths[i] ?? h.length)).join('  '));
  for (const cell of cells) {
    lines.push(cell.map((value, i) => pad(value, widths[i] ?? value.length)).join('  '));
  }
  return `${lines.join('\n')}\n`;
}

export async function runToolsSearch(
  query: string,
  options: ToolsSearchOptions,
  deps: ToolsCommandDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }

  const cachePath = deps.resolveCachePath(target);
  let cache;
  try {
    cache = await readToolCache(cachePath);
  } catch (error) {
    if (error instanceof ToolCacheMissingError) {
      deps.stderr(
        `${error.message} Run \`tlbx serve\` once so ToolBox can populate the registry.\n`,
      );
      return 1;
    }
    if (error instanceof ToolCacheError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // Reconcile cached custom rows against the live manifest before searching, so a
  // tool disabled or removed via `tlbx tool disable/remove` is reflected here too
  // (the same reconciliation `tlbx tools list` applies).
  const manifestByExposed = await readCustomManifestMap(target, deps);
  const enabledByExposed = new Map<string, boolean>();
  const sourceByExposed = new Map<string, 'upstream' | 'custom'>();
  const tools: RegisteredToolView[] = [];
  for (const entry of cache.tools) {
    const reconciled = reconcileCachedTool(entry, config, manifestByExposed);
    if (!reconciled.keep) {
      continue;
    }
    enabledByExposed.set(entry.exposedName, reconciled.enabled);
    sourceByExposed.set(entry.exposedName, reconciled.toolSource);
    tools.push({
      exposedName: entry.exposedName,
      serverName: entry.serverName,
      upstreamName: entry.upstreamName,
      // The cache stores `Tool` payloads loosely; widen to the SDK shape — the
      // search function only reads `name`, `title`, `description`, `inputSchema`.
      tool: entry.tool as RegisteredToolView['tool'],
    });
  }

  const limit = options.limit ?? config.progressiveDisclosure.maxSearchResults;
  const ranked = searchTools(query, tools, { limit });

  const rows: ResultRow[] = ranked.map((entry) => ({
    exposedName: entry.tool.exposedName,
    serverName: entry.tool.serverName,
    upstreamName: entry.tool.upstreamName,
    enabled: enabledByExposed.get(entry.tool.exposedName) ?? true,
    source: sourceByExposed.get(entry.tool.exposedName) ?? 'upstream',
    score: entry.score,
    matchedFields: entry.matchedFields,
  }));

  if (options.json === true) {
    deps.stdout(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }

  deps.stdout(formatTable(rows));
  return 0;
}

export function toolsSearchCommand(): CommandUnknownOpts {
  return new Command('search')
    .description('Search tools known to ToolBox using the bootstrap-tool ranking.')
    .argument('<query>', 'free-text query')
    .option('--json', 'emit machine-readable JSON instead of a table')
    .option('--limit <n>', 'cap the result count', (v) => {
      try {
        return parsePositiveInt(v);
      } catch (err) {
        if (err instanceof InvalidArgumentError) {
          throw err;
        }
        throw new InvalidArgumentError(String(err));
      }
    })
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (query, opts) => {
      const code = await runToolsSearch(query, opts, {
        ...defaultServerCommandDeps(),
        resolveCachePath: defaultResolveCachePath,
      });
      if (code !== 0) {
        process.exit(code);
      }
    });
}
