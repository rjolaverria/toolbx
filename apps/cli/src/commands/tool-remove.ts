import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { removeTool, ToolManifestError } from '@toolbox/custom-tools';

import {
  defaultConfirmDeps,
  defaultToolCommandDeps,
  reportManifestError,
  resolveConfigDir,
  type ConfirmDeps,
  type ToolCommandDeps,
} from './tool-shared.js';

export interface ToolRemoveOptions {
  config?: string;
  yes?: true;
}

export type ToolRemoveDeps = ToolCommandDeps & ConfirmDeps;

export function defaultToolRemoveDeps(): ToolRemoveDeps {
  return { ...defaultToolCommandDeps(), ...defaultConfirmDeps() };
}

export async function runToolRemove(
  exposedName: string,
  options: ToolRemoveOptions,
  deps: ToolRemoveDeps,
): Promise<number> {
  const configDir = resolveConfigDir(deps, options.config);

  if (options.yes !== true) {
    if (!deps.isTty()) {
      deps.stderr(
        `Refusing to remove "${exposedName}" without confirmation. Re-run with --yes in non-interactive shells.\n`,
      );
      return 2;
    }
    const confirmed = await deps.confirm(`Remove custom tool "${exposedName}"? [y/N] `);
    if (!confirmed) {
      deps.stderr(`Aborted. Custom tool "${exposedName}" was not removed.\n`);
      return 1;
    }
  }

  try {
    const result = await removeTool(configDir, exposedName);
    const suffix = result.sourceRemoved ? '' : ' (source file was already missing)';
    deps.stdout(`Removed custom tool "${exposedName}"${suffix}.\n`);
    return 0;
  } catch (error) {
    if (error instanceof ToolManifestError) {
      return reportManifestError(error, deps);
    }
    throw error;
  }
}

export function toolRemoveCommand(): CommandUnknownOpts {
  return new Command('remove')
    .description('Remove an imported custom tool (deletes its source file and manifest entry).')
    .argument('<exposedName>', 'exposed (namespaced) tool name, e.g. personal__my_tool')
    .option('-y, --yes', 'skip the interactive confirmation prompt')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (exposedName, opts) => {
      const code = await runToolRemove(exposedName, opts, defaultToolRemoveDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
