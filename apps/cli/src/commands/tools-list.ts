import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';

import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  resolveTargetPath,
} from './server-shared.js';
import {
  defaultResolveCachePath,
  loadTools,
  readCustomManifestMap,
  type ToolView,
  type ToolsCommandDeps,
} from './tools-shared.js';

export interface ToolsListOptions {
  config?: string;
  json?: true;
  fromConfig?: true;
  server?: string;
}

export function defaultToolsCommandDeps(): ToolsCommandDeps {
  return {
    ...defaultServerCommandDeps(),
    resolveCachePath: defaultResolveCachePath,
  };
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return value + ' '.repeat(width - value.length);
}

function formatTable(rows: readonly ToolView[], emptyMessage: string): string {
  if (rows.length === 0) {
    return emptyMessage;
  }
  const headers = ['EXPOSED', 'SERVER', 'TOOL', 'ENABLED', 'SOURCE'];
  const cells = rows.map((row) => [
    row.exposedName,
    row.serverName,
    row.upstreamName,
    row.enabled ? 'yes' : 'no',
    row.toolSource,
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

interface JsonRow {
  exposedName: string;
  serverName: string;
  upstreamName: string;
  enabled: boolean;
  source: 'upstream' | 'custom';
}

function buildJsonRows(rows: readonly ToolView[]): JsonRow[] {
  return rows.map((row) => ({
    exposedName: row.exposedName,
    serverName: row.serverName,
    upstreamName: row.upstreamName,
    enabled: row.enabled,
    source: row.toolSource,
  }));
}

export async function runToolsList(
  options: ToolsListOptions,
  deps: ToolsCommandDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }

  const fromConfig = options.fromConfig === true;
  if (options.server !== undefined && config.servers[options.server] === undefined) {
    // A `--server` filter may also name a custom-tool namespace, which appears in
    // the SERVER column but has no `config.servers` entry. Accept it when the
    // manifest has that namespace; reject only a name that is neither.
    const manifestMap = await readCustomManifestMap(target, deps);
    const customNamespaces = new Set([...manifestMap.values()].map((m) => m.namespace));
    if (!customNamespaces.has(options.server)) {
      deps.stderr(`Unknown server or namespace "${options.server}" in ${target}.\n`);
      return 1;
    }
  }

  const result = await loadTools(
    config,
    target,
    {
      ...(fromConfig ? { fromConfig: true } : {}),
      ...(options.server !== undefined ? { serverFilter: options.server } : {}),
    },
    deps,
  );
  if (result.kind === 'error') {
    return 1;
  }

  if (options.json === true) {
    const payload = {
      source: result.source,
      ...(result.source === 'cache' ? { updatedAt: result.updatedAt } : {}),
      tools: buildJsonRows(result.tools),
    };
    deps.stdout(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  if (result.source === 'config') {
    const configured = Object.keys(config.servers).filter(
      (name) => options.server === undefined || name === options.server,
    );
    if (configured.length === 0) {
      deps.stdout(
        options.server !== undefined
          ? `Server "${options.server}" is not configured.\n`
          : 'No servers configured.\n',
      );
      return 0;
    }
    deps.stdout(
      `${configured.length} server(s) configured: ${configured.sort().join(', ')}.\n` +
        `Run \`tlbx serve\` once to populate the tool inventory.\n`,
    );
    return 0;
  }

  // Empty cache vs filtered-out are distinct UX cases. The cache file exists
  // (loadTools succeeded), so "no rows" with a `--server` filter means the
  // filter matched no entries, not that the registry has never been
  // populated.
  const emptyMessage =
    options.server !== undefined
      ? `No tools match server "${options.server}".\n`
      : 'No tools cached. Run `tlbx serve` once to populate the registry.\n';
  deps.stdout(formatTable(result.tools, emptyMessage));
  return 0;
}

export function toolsListCommand(): CommandUnknownOpts {
  return new Command('list')
    .description('List tools known to Toolbx.')
    .option('--json', 'emit machine-readable JSON instead of a table')
    .option('--from-config', 'list only the configured servers when no cache is available')
    .option('--server <name>', 'filter by upstream server name')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (opts) => {
      const code = await runToolsList(opts, defaultToolsCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
