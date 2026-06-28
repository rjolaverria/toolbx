import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { setToolEnabled, ToolManifestError } from '@toolbx/custom-tools';

import {
  defaultToolCommandDeps,
  reportManifestError,
  resolveValidatedConfigDir,
  type ToolCommandDeps,
} from './tool-shared.js';

export interface ToolToggleOptions {
  config?: string;
}

async function applyEnabledChange(
  exposedName: string,
  desired: boolean,
  options: ToolToggleOptions,
  deps: ToolCommandDeps,
): Promise<number> {
  const configDir = await resolveValidatedConfigDir(deps, options.config);
  if (configDir === null) {
    return 1;
  }
  try {
    const result = await setToolEnabled(configDir, exposedName, desired);
    if (!result.changed) {
      deps.stdout(`Custom tool "${exposedName}" is already ${desired ? 'enabled' : 'disabled'}.\n`);
      return 0;
    }
    deps.stdout(`Custom tool "${exposedName}" ${desired ? 'enabled' : 'disabled'}.\n`);
    return 0;
  } catch (error) {
    if (error instanceof ToolManifestError) {
      return reportManifestError(error, deps);
    }
    throw error;
  }
}

export function runToolEnable(
  exposedName: string,
  options: ToolToggleOptions,
  deps: ToolCommandDeps,
): Promise<number> {
  return applyEnabledChange(exposedName, true, options, deps);
}

export function runToolDisable(
  exposedName: string,
  options: ToolToggleOptions,
  deps: ToolCommandDeps,
): Promise<number> {
  return applyEnabledChange(exposedName, false, options, deps);
}

export function toolEnableCommand(): CommandUnknownOpts {
  return new Command('enable')
    .description('Enable an imported custom tool.')
    .argument('<exposedName>', 'exposed (namespaced) tool name, e.g. personal__my_tool')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (exposedName, opts) => {
      const code = await runToolEnable(exposedName, opts, defaultToolCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}

export function toolDisableCommand(): CommandUnknownOpts {
  return new Command('disable')
    .description('Disable an imported custom tool.')
    .argument('<exposedName>', 'exposed (namespaced) tool name, e.g. personal__my_tool')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (exposedName, opts) => {
      const code = await runToolDisable(exposedName, opts, defaultToolCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
