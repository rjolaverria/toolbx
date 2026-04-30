import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { saveConfig, type ServerConfig, type ToolboxConfig } from '@toolbox/core';

import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  requireExistingServer,
  resolveTargetPath,
  validateNextConfig,
  type ServerCommandDeps,
} from './server-shared.js';

export interface ToggleOptions {
  config?: string;
}

async function applyEnabledChange(
  name: string,
  desired: boolean,
  options: ToggleOptions,
  deps: ServerCommandDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  const config = await loadOrReportMissing(target, deps);
  if (config === null) {
    return 1;
  }
  const entry = requireExistingServer(config, name, target, deps);
  if (entry === null) {
    return 1;
  }

  if (entry.enabled === desired) {
    deps.stdout(`Server "${name}" is already ${desired ? 'enabled' : 'disabled'}.\n`);
    return 0;
  }

  const updated: ServerConfig = { ...entry, enabled: desired };
  const candidate: ToolboxConfig = {
    ...config,
    servers: { ...config.servers, [name]: updated },
  };
  const validated = validateNextConfig(candidate, target, deps);
  if (!validated.ok) {
    return 1;
  }
  await saveConfig(validated.next, target);
  deps.stdout(`Server "${name}" ${desired ? 'enabled' : 'disabled'}.\n`);
  return 0;
}

export function runEnable(
  name: string,
  options: ToggleOptions,
  deps: ServerCommandDeps,
): Promise<number> {
  return applyEnabledChange(name, true, options, deps);
}

export function runDisable(
  name: string,
  options: ToggleOptions,
  deps: ServerCommandDeps,
): Promise<number> {
  return applyEnabledChange(name, false, options, deps);
}

export function enableCommand(): CommandUnknownOpts {
  return new Command('enable')
    .description('Enable a configured upstream MCP server.')
    .argument('<name>', 'server name')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (name, opts) => {
      const code = await runEnable(name, opts, defaultServerCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}

export function disableCommand(): CommandUnknownOpts {
  return new Command('disable')
    .description('Disable a configured upstream MCP server.')
    .argument('<name>', 'server name')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (name, opts) => {
      const code = await runDisable(name, opts, defaultServerCommandDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
