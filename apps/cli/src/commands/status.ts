import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import type { ServerConfig, ToolBoxConfig } from '@toolbox/core';

import { probeServer, type ProbeResult, type ProbeServerFn } from './server-probe.js';
import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  parsePositiveInt,
  resolveTargetPath,
  type ServerCommandDeps,
} from './server-shared.js';

export interface StatusOptions {
  config?: string;
  json?: true;
  server?: string;
  connect?: boolean;
  timeout?: number;
}

export interface StatusDeps extends ServerCommandDeps {
  probe: ProbeServerFn;
}

export function defaultStatusDeps(): StatusDeps {
  return {
    ...defaultServerCommandDeps(),
    probe: probeServer,
  };
}

type StatusKind = 'disabled' | 'enabled' | 'connected' | 'auth_required' | 'error';
type AuthKind = 'none' | 'ok' | 'required' | 'unknown';

interface Row {
  name: string;
  type: 'stdio' | 'http';
  enabled: boolean;
  status: StatusKind;
  auth: AuthKind;
  toolCount: number | null;
  lastConnectedAt: Date | null;
  lastError: string | null;
}

interface JsonRow {
  name: string;
  type: 'stdio' | 'http';
  enabled: boolean;
  status: StatusKind;
  auth: AuthKind;
  toolCount: number | null;
  lastConnectedAt: string | null;
  lastError: string | null;
}

function hasAuth(entry: ServerConfig): boolean {
  return entry.type === 'http' && entry.auth !== undefined && entry.auth.type !== 'none';
}

function rowFromConfigOnly(name: string, entry: ServerConfig): Row {
  return {
    name,
    type: entry.type,
    enabled: entry.enabled,
    status: entry.enabled ? 'enabled' : 'disabled',
    auth: 'unknown',
    toolCount: null,
    lastConnectedAt: null,
    lastError: null,
  };
}

function rowFromProbe(name: string, entry: ServerConfig, result: ProbeResult): Row {
  const base = {
    name,
    type: entry.type,
    enabled: entry.enabled,
    toolCount: null as number | null,
    lastConnectedAt: null as Date | null,
    lastError: null as string | null,
  };
  switch (result.kind) {
    case 'disabled':
      return { ...base, status: 'disabled', auth: 'none' };
    case 'connected':
      return {
        ...base,
        status: 'connected',
        auth: hasAuth(entry) ? 'ok' : 'none',
        toolCount: result.tools.length,
        lastConnectedAt: result.connectedAt,
      };
    case 'auth_required':
      return {
        ...base,
        status: 'auth_required',
        auth: 'required',
        lastError: result.reason,
      };
    case 'error':
      return {
        ...base,
        status: 'error',
        auth: hasAuth(entry) ? 'unknown' : 'none',
        lastError: result.error.message,
      };
  }
}

function toJsonRow(row: Row): JsonRow {
  return {
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    status: row.status,
    auth: row.auth,
    toolCount: row.toolCount,
    lastConnectedAt: row.lastConnectedAt === null ? null : row.lastConnectedAt.toISOString(),
    lastError: row.lastError,
  };
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return value + ' '.repeat(width - value.length);
}

function formatTable(rows: Row[]): string {
  if (rows.length === 0) {
    return 'No servers configured.\n';
  }
  const headers = [
    'NAME',
    'TYPE',
    'ENABLED',
    'STATUS',
    'AUTH',
    'TOOLS',
    'LAST CONNECTED',
    'LAST ERROR',
  ];
  const cells = rows.map((row) => [
    row.name,
    row.type,
    row.enabled ? 'yes' : 'no',
    row.status,
    row.auth === 'unknown' ? '-' : row.auth,
    row.toolCount === null ? '-' : String(row.toolCount),
    row.lastConnectedAt === null ? '-' : row.lastConnectedAt.toISOString(),
    row.lastError ?? '-',
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

function selectServers(
  config: ToolBoxConfig,
  filter: string | undefined,
): Array<[string, ServerConfig]> {
  const all = Object.entries(config.servers).sort(([a], [b]) => a.localeCompare(b));
  if (filter === undefined) {
    return all;
  }
  return all.filter(([name]) => name === filter);
}

function exitCodeFor(rows: Row[]): number {
  for (const row of rows) {
    if (!row.enabled) {
      continue;
    }
    if (row.status === 'error' || row.status === 'auth_required') {
      return 1;
    }
  }
  return 0;
}

export async function runStatus(options: StatusOptions, deps: StatusDeps): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }

  const selected = selectServers(config, options.server);
  if (options.server !== undefined && selected.length === 0) {
    deps.stderr(`Unknown server "${options.server}" in ${target}.\n`);
    return 1;
  }

  const noConnect = options.connect === false;

  let rows: Row[];
  if (noConnect) {
    rows = selected.map(([name, entry]) => rowFromConfigOnly(name, entry));
  } else {
    const probeOptions: { timeoutMs?: number } = {};
    if (options.timeout !== undefined) {
      probeOptions.timeoutMs = options.timeout;
    }
    const results = await Promise.all(
      selected.map(async ([name, entry]) => {
        const result = await deps.probe(name, entry, probeOptions);
        return rowFromProbe(name, entry, result);
      }),
    );
    rows = results;
  }

  if (options.json === true) {
    deps.stdout(`${JSON.stringify(rows.map(toJsonRow), null, 2)}\n`);
  } else {
    deps.stdout(formatTable(rows));
  }

  return exitCodeFor(rows);
}

export function statusCommand(): CommandUnknownOpts {
  return new Command('status')
    .description('Probe every configured upstream MCP server and print a status table.')
    .option('--json', 'emit machine-readable JSON instead of a table')
    .option('--server <name>', 'only report status for this server')
    .option('--no-connect', 'read config only; do not start upstream sessions')
    .option(
      '--timeout <ms>',
      'override the probe timeout (defaults to the server timeoutMs)',
      parsePositiveInt,
    )
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (opts) => {
      const code = await runStatus(opts, defaultStatusDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
