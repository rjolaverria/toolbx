import * as path from 'node:path';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  commitImport,
  planImport,
  ToolImportError,
  ToolMetadataParseError,
  type ImportPlan,
} from '@toolbox/custom-tools';

import { loadOrReportMissing, resolveTargetPath } from './server-shared.js';
import {
  defaultConfirmDeps,
  defaultToolCommandDeps,
  type ConfirmDeps,
  type ToolCommandDeps,
} from './tool-shared.js';

export interface ToolImportOptions {
  config?: string;
  yes?: true;
}

export type ToolImportDeps = ToolCommandDeps & ConfirmDeps;

export function defaultToolImportDeps(): ToolImportDeps {
  return { ...defaultToolCommandDeps(), ...defaultConfirmDeps() };
}

function formatPreview(plan: ImportPlan): string {
  const { manifest } = plan;
  const lines: string[] = [];
  lines.push('About to import a custom tool:');
  lines.push(`  name:        ${manifest.name}`);
  lines.push(`  namespace:   ${manifest.namespace}`);
  lines.push(`  exposed as:  ${manifest.exposedName}`);
  lines.push(`  title:       ${manifest.title}`);
  lines.push(`  description: ${manifest.description}`);
  lines.push(`  stored at:   ${plan.entryPath}`);
  lines.push('');
  lines.push('Permissions:');
  lines.push(`  network:     ${manifest.permissions.network ? 'yes' : 'no'}`);
  lines.push(`  filesystem:  ${manifest.permissions.filesystem ? 'yes' : 'no'}`);
  lines.push(
    `  env:         ${
      manifest.permissions.env.length > 0 ? manifest.permissions.env.join(', ') : '(none)'
    }`,
  );
  if (plan.replacesExisting) {
    lines.push('');
    lines.push(`This overwrites the existing tool "${manifest.exposedName}".`);
  }
  for (const warning of plan.warnings) {
    lines.push(`  warning (line ${warning.line}): ${warning.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runToolImport(
  sourceArg: string,
  options: ToolImportOptions,
  deps: ToolImportDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }
  const configDir = path.dirname(target);
  const sourcePath = path.resolve(deps.cwd(), sourceArg);
  const serverNames = Object.keys(config.servers);

  let plan: ImportPlan;
  try {
    plan = await planImport(sourcePath, {
      configDir,
      serverNames,
      separator: config.namespacing.separator,
    });
  } catch (error) {
    if (error instanceof ToolMetadataParseError || error instanceof ToolImportError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // A permission preview must precede the write (SPECS §6.6.1), so confirmation
  // happens against the planned manifest before anything touches disk.
  deps.stdout(formatPreview(plan));

  if (options.yes !== true) {
    if (!deps.isTty()) {
      deps.stderr(
        `Refusing to import "${plan.manifest.exposedName}" without confirmation. Re-run with --yes in non-interactive shells.\n`,
      );
      return 2;
    }
    const confirmed = await deps.confirm(`Import "${plan.manifest.exposedName}"? [y/N] `);
    if (!confirmed) {
      deps.stderr(`Aborted. Custom tool "${plan.manifest.exposedName}" was not imported.\n`);
      return 1;
    }
  }

  // commitImport re-reads the manifest, so it can fail late (a tool imported
  // concurrently during the prompt, or a manifest that became corrupt). Surface
  // those as a normal command error rather than letting them reach the
  // top-level handler.
  let result: Awaited<ReturnType<typeof commitImport>>;
  try {
    result = await commitImport(plan);
  } catch (error) {
    if (error instanceof ToolImportError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  deps.stdout(
    `Imported "${result.manifest.exposedName}" (disabled). ` +
      `Enable it with \`tlbx tool enable ${result.manifest.exposedName}\`.\n`,
  );
  return 0;
}

export function toolImportCommand(): CommandUnknownOpts {
  return new Command('import')
    .description('Import a local .ts or .js custom tool file into ToolBox.')
    .argument('<path>', 'path to the .ts or .js tool file')
    .option('-y, --yes', 'skip the interactive confirmation prompt')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (sourcePath, opts) => {
      const code = await runToolImport(sourcePath, opts, defaultToolImportDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
