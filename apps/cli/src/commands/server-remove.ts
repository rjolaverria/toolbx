import * as readline from 'node:readline/promises';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { saveConfig, type ToolboxConfig } from '@toolbox/core';

import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  requireExistingServer,
  resolveTargetPath,
  validateNextConfig,
  type ServerCommandDeps,
} from './server-shared.js';

export interface RemoveOptions {
  config?: string;
  yes?: true;
}

export interface RemoveDeps extends ServerCommandDeps {
  isTty: () => boolean;
  confirm: (question: string) => Promise<boolean>;
}

export function defaultRemoveDeps(): RemoveDeps {
  const base = defaultServerCommandDeps();
  return {
    ...base,
    isTty: () => process.stdin.isTTY === true,
    confirm: async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(question);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}

export async function runServerRemove(
  name: string,
  options: RemoveOptions,
  deps: RemoveDeps,
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

  if (options.yes !== true) {
    if (!deps.isTty()) {
      deps.stderr(
        `Refusing to remove "${name}" without confirmation. Re-run with --yes in non-interactive shells.\n`,
      );
      return 2;
    }
    const confirmed = await deps.confirm(`Remove server "${name}" from ${target}? [y/N] `);
    if (!confirmed) {
      deps.stderr(`Aborted. Server "${name}" was not removed.\n`);
      return 1;
    }
  }

  const nextServers: ToolboxConfig['servers'] = { ...config.servers };
  delete nextServers[name];
  const candidate: ToolboxConfig = { ...config, servers: nextServers };
  const validated = validateNextConfig(candidate, target, deps);
  if (!validated.ok) {
    return 1;
  }
  await saveConfig(validated.next, target);
  deps.stdout(`Removed server "${name}".\n`);
  return 0;
}

export function removeCommand(): CommandUnknownOpts {
  return new Command('remove')
    .description('Remove a configured upstream MCP server.')
    .argument('<name>', 'server name')
    .option('-y, --yes', 'skip the interactive confirmation prompt')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (name, opts) => {
      const code = await runServerRemove(name, opts, defaultRemoveDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
