import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import type { ServerConfig, ToolbxConfig } from '@toolbx/core';

import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  resolveTargetPath,
  type ServerCommandDeps,
} from './server-shared.js';

export interface ListOptions {
  config?: string;
  json?: true;
}

interface ListRow {
  name: string;
  type: 'stdio' | 'http';
  enabled: boolean;
  target: string;
  timeoutMs: number | null;
}

interface JsonStdioRow {
  name: string;
  type: 'stdio';
  enabled: boolean;
  command: string;
  args: string[];
  timeoutMs: number | null;
}

interface JsonHttpRow {
  name: string;
  type: 'http';
  enabled: boolean;
  url: string;
  timeoutMs: number | null;
}

type JsonRow = JsonStdioRow | JsonHttpRow;

function targetForServer(entry: ServerConfig): string {
  if (entry.type === 'stdio') {
    if (entry.args.length === 0) {
      return entry.command;
    }
    return `${entry.command} ${entry.args.join(' ')}`;
  }
  return entry.url;
}

function buildRows(config: ToolbxConfig): ListRow[] {
  return Object.entries(config.servers)
    .map(([name, entry]) => ({
      name,
      type: entry.type,
      enabled: entry.enabled,
      target: targetForServer(entry),
      timeoutMs: entry.timeoutMs ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildJsonRows(config: ToolbxConfig): JsonRow[] {
  return Object.entries(config.servers)
    .map(([name, entry]): JsonRow => {
      if (entry.type === 'stdio') {
        return {
          name,
          type: 'stdio',
          enabled: entry.enabled,
          command: entry.command,
          args: entry.args,
          timeoutMs: entry.timeoutMs ?? null,
        };
      }
      return {
        name,
        type: 'http',
        enabled: entry.enabled,
        url: entry.url,
        timeoutMs: entry.timeoutMs ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return value + ' '.repeat(width - value.length);
}

function formatTable(rows: ListRow[]): string {
  if (rows.length === 0) {
    return 'No servers configured.\n';
  }
  const headers = ['NAME', 'TYPE', 'ENABLED', 'TARGET', 'TIMEOUT'];
  const cells = rows.map((row) => [
    row.name,
    row.type,
    row.enabled ? 'yes' : 'no',
    row.target,
    row.timeoutMs === null ? '-' : `${row.timeoutMs}ms`,
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

export async function runServerList(
  options: ListOptions,
  deps: ServerCommandDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }

  if (options.json === true) {
    const rows = buildJsonRows(config);
    deps.stdout(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }

  deps.stdout(formatTable(buildRows(config)));
  return 0;
}

export function listCommand(): CommandUnknownOpts {
  return new Command('list')
    .description('List all configured upstream MCP servers.')
    .option('--json', 'emit machine-readable JSON instead of a table')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (opts) => {
      const code = await runServerList(opts, defaultServerCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
