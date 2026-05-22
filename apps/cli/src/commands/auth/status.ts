import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import type { StoredOAuthRecord, ToolBoxConfig } from '@toolbox/core';

import { loadOrReportMissing, resolveTargetPath } from '../server-shared.js';
import { defaultAuthCommandDeps, isOAuthServer, type AuthCommandDeps } from './shared.js';

export interface AuthStatusOptions {
  config?: string;
}

interface StatusRow {
  name: string;
  hasToken: boolean;
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return value + ' '.repeat(width - value.length);
}

function formatTable(rows: readonly StatusRow[]): string {
  const headers = ['SERVER', 'TOKEN', 'STATUS'];
  const cells = rows.map((row) => [
    row.name,
    row.hasToken ? '✓' : '—',
    row.hasToken ? 'authenticated' : 'pending',
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

function oauthServerNames(config: ToolBoxConfig): string[] {
  return Object.entries(config.servers)
    .filter(([, entry]) => isOAuthServer(entry))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

function formatDetail(name: string, record: StoredOAuthRecord | null): string {
  const rows: Array<[string, string]> = [
    ['Server', name],
    ['Auth type', 'oauth'],
    ['Stored credentials', record === null ? 'no' : 'yes'],
  ];
  if (record !== null) {
    rows.push(['Obtained at', record.obtainedAt]);
    rows.push(['Scopes', record.scopes.length > 0 ? record.scopes.join(', ') : '(none)']);
    rows.push(['Authorization server', record.authorizationServer]);
  }
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  // Token bytes are deliberately never included in any row.
  return `${rows.map(([label, value]) => `${pad(`${label}:`, labelWidth + 1)}  ${value}`).join('\n')}\n`;
}

export async function runAuthStatus(
  serverArg: string | undefined,
  options: AuthStatusOptions,
  deps: AuthCommandDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }

  const tokenStore = deps.createTokenStore(config.auth.storage);

  if (serverArg !== undefined) {
    const entry = config.servers[serverArg];
    if (entry === undefined || !isOAuthServer(entry)) {
      const detail = entry === undefined ? 'is not configured' : 'is not configured for OAuth';
      deps.stderr(`Server "${serverArg}" ${detail}.\n`);
      return 1;
    }
    const record = await tokenStore.read(serverArg);
    deps.stdout(formatDetail(serverArg, record));
    return 0;
  }

  const names = oauthServerNames(config);
  if (names.length === 0) {
    deps.stdout('No OAuth-configured servers.\n');
    return 0;
  }

  const rows = await Promise.all(
    names.map(async (name) => ({ name, hasToken: (await tokenStore.read(name)) !== null })),
  );
  deps.stdout(formatTable(rows));
  return 0;
}

export function authStatusCommand(): CommandUnknownOpts {
  return new Command('status')
    .description('Show OAuth credential state for configured servers.')
    .argument('[server]', 'limit output to a single server')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (server, opts) => {
      const code = await runAuthStatus(server, opts, defaultAuthCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
