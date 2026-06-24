import * as fs from 'node:fs/promises';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  findToolByExposedName,
  readToolManifest,
  resolveToolEntryPath,
  ToolManifestError,
  type ToolManifest,
} from '@rjolaverria/toolbox-custom-tools';

import {
  defaultToolCommandDeps,
  reportManifestError,
  resolveValidatedConfigDir,
  type ToolCommandDeps,
} from './tool-shared.js';

/** Lines of the tool source shown in the inspect preview. */
const SOURCE_HEAD_LINES = 40;

export interface ToolInspectOptions {
  config?: string;
  json?: true;
}

interface SourcePreview {
  /** The first lines of the source file, or null when it could not be read. */
  lines: string[] | null;
  truncated: boolean;
  /** Present only when the source file could not be read. */
  error?: string;
}

async function readSourceHead(entryPath: string): Promise<SourcePreview> {
  let raw: string;
  try {
    raw = await fs.readFile(entryPath, 'utf8');
  } catch (error) {
    return { lines: null, truncated: false, error: (error as Error).message };
  }
  const allLines = raw.split('\n');
  const lines = allLines.slice(0, SOURCE_HEAD_LINES);
  return { lines, truncated: allLines.length > SOURCE_HEAD_LINES };
}

function formatHuman(entry: ToolManifest, entryPath: string, preview: SourcePreview): string {
  const lines: string[] = [];
  lines.push('manifest:');
  // The manifest carries only declared permission.env *names*, never values, so
  // printing it whole cannot leak a secret.
  lines.push(JSON.stringify(entry, null, 2));
  lines.push('');
  lines.push(`source (${entryPath}):`);
  if (preview.lines === null) {
    lines.push(`  <could not read source: ${preview.error ?? 'unknown error'}>`);
  } else {
    for (const line of preview.lines) {
      lines.push(`  ${line}`);
    }
    if (preview.truncated) {
      lines.push(`  … (truncated at ${SOURCE_HEAD_LINES} lines)`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function runToolInspect(
  exposedName: string,
  options: ToolInspectOptions,
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

  const entry = findToolByExposedName(entries, exposedName);
  if (entry === undefined) {
    deps.stderr(`No custom tool named "${exposedName}".\n`);
    return 1;
  }

  let entryPath: string;
  try {
    entryPath = resolveToolEntryPath(configDir, entry);
  } catch (error) {
    if (error instanceof ToolManifestError) {
      return reportManifestError(error, deps);
    }
    throw error;
  }
  const preview = await readSourceHead(entryPath);

  if (options.json === true) {
    deps.stdout(`${JSON.stringify({ manifest: entry, entryPath, source: preview }, null, 2)}\n`);
    return 0;
  }
  deps.stdout(formatHuman(entry, entryPath, preview));
  return 0;
}

export function toolInspectCommand(): CommandUnknownOpts {
  return new Command('inspect')
    .description('Show a custom tool manifest plus a head of its source file.')
    .argument('<exposedName>', 'exposed (namespaced) tool name, e.g. personal__my_tool')
    .option('--json', 'emit machine-readable JSON instead of human output')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (exposedName, opts) => {
      const code = await runToolInspect(exposedName, opts, defaultToolCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
