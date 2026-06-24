import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  readToolManifest,
  ToolManifestError,
  type ToolManifest,
} from '@rjolaverria/toolbox-custom-tools';

import {
  defaultToolCommandDeps,
  reportManifestError,
  resolveValidatedConfigDir,
  type ToolCommandDeps,
} from './tool-shared.js';

export interface ToolListOptions {
  config?: string;
  json?: true;
}

interface ListRow {
  name: string;
  namespace: string;
  exposedName: string;
  enabled: boolean;
}

function toRow(entry: ToolManifest): ListRow {
  return {
    name: entry.name,
    namespace: entry.namespace,
    exposedName: entry.exposedName,
    enabled: entry.enabled,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function formatTable(rows: ListRow[]): string {
  if (rows.length === 0) {
    return 'No custom tools imported.\n';
  }
  const headers = ['NAME', 'NAMESPACE', 'EXPOSED', 'ENABLED'];
  const cells = rows.map((row) => [
    row.name,
    row.namespace,
    row.exposedName,
    row.enabled ? 'yes' : 'no',
  ]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...cells.map((cell) => (cell[i] ?? '').length)),
  );
  const lines: string[] = [];
  lines.push(headers.map((header, i) => pad(header, widths[i] ?? header.length)).join('  '));
  for (const cell of cells) {
    lines.push(cell.map((value, i) => pad(value, widths[i] ?? value.length)).join('  '));
  }
  return `${lines.join('\n')}\n`;
}

export async function runToolList(
  options: ToolListOptions,
  deps: ToolCommandDeps,
): Promise<number> {
  const configDir = await resolveValidatedConfigDir(deps, options.config);
  if (configDir === null) {
    return 1;
  }
  let entries: ToolManifest[];
  try {
    entries = await readToolManifest(configDir);
  } catch (error) {
    if (error instanceof ToolManifestError) {
      return reportManifestError(error, deps);
    }
    throw error;
  }

  const rows = entries.map(toRow).sort((a, b) => a.exposedName.localeCompare(b.exposedName));

  if (options.json === true) {
    deps.stdout(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  deps.stdout(formatTable(rows));
  return 0;
}

export function toolListCommand(): CommandUnknownOpts {
  return new Command('list')
    .description('List imported custom tools.')
    .option('--json', 'emit machine-readable JSON instead of a table')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (opts) => {
      const code = await runToolList(opts, defaultToolCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
