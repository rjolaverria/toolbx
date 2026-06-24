import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import type { StoredOAuthRecord, ToolBoxConfig } from '@rjolaverria/toolbox-core';

import { loadOrReportMissing, resolveTargetPath } from '../server-shared.js';
import { defaultAuthCommandDeps, isOAuthServer, type AuthCommandDeps } from './shared.js';

export interface AuthStatusOptions {
  config?: string;
}

type TokenState = 'present' | 'absent' | 'error';

interface StatusRow {
  name: string;
  state: TokenState;
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return value + ' '.repeat(width - value.length);
}

const TOKEN_CELL: Record<TokenState, string> = { present: '✓', absent: '—', error: '!' };
const STATUS_CELL: Record<TokenState, string> = {
  present: 'authenticated',
  absent: 'pending',
  error: 'error reading',
};

function formatTable(rows: readonly StatusRow[]): string {
  const headers = ['SERVER', 'TOKEN', 'STATUS'];
  const cells = rows.map((row) => [row.name, TOKEN_CELL[row.state], STATUS_CELL[row.state]]);
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
    let record: StoredOAuthRecord | null;
    try {
      record = await tokenStore.read(serverArg);
    } catch (error) {
      deps.stderr(
        `Could not read stored credentials for ${serverArg}: ${
          error instanceof Error ? error.message : String(error)
        }. Run \`tlbx doctor\` for details.\n`,
      );
      return 1;
    }
    deps.stdout(formatDetail(serverArg, record));
    return 0;
  }

  const names = oauthServerNames(config);
  if (names.length === 0) {
    deps.stdout('No OAuth-configured servers.\n');
    return 0;
  }

  // Read each entry independently so one unreadable credential (locked keychain,
  // corrupt record) surfaces as an `error` row instead of taking down the whole
  // table. A non-zero exit still signals that at least one entry could not be read.
  const rows: StatusRow[] = await Promise.all(
    names.map(async (name): Promise<StatusRow> => {
      try {
        return { name, state: (await tokenStore.read(name)) !== null ? 'present' : 'absent' };
      } catch {
        return { name, state: 'error' };
      }
    }),
  );
  deps.stdout(formatTable(rows));
  return rows.some((row) => row.state === 'error') ? 1 : 0;
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
