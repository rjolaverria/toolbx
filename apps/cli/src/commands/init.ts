import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Command } from '@commander-js/extra-typings';
import { DEFAULT_CONFIG, resolveConfigPath, saveConfig } from '@toolbox/core';

export interface InitOptions {
  force?: boolean;
  path?: string;
}

export interface InitDeps {
  resolvePath: () => string;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
  cwd: () => string;
}

export function defaultInitDeps(): InitDeps {
  return {
    resolvePath: () => resolveConfigPath(),
    stdout: (msg) => {
      process.stdout.write(msg);
    },
    stderr: (msg) => {
      process.stderr.write(msg);
    },
    cwd: () => process.cwd(),
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function runInit(options: InitOptions, deps: InitDeps): Promise<number> {
  const target =
    options.path !== undefined && options.path.length > 0
      ? path.resolve(deps.cwd(), options.path)
      : deps.resolvePath();

  if (options.force !== true && (await pathExists(target))) {
    deps.stderr(`Config already exists at ${target}. Re-run with --force to overwrite.\n`);
    return 1;
  }

  await saveConfig(DEFAULT_CONFIG, target);
  deps.stdout(`Created Toolbox config at ${target}\n`);
  deps.stdout('Next: run `tlbx serve` to start the gateway.\n');
  return 0;
}

export function initCommand(): Command {
  return new Command('init')
    .description('Create a new Toolbox config file at the resolved location.')
    .option('-f, --force', 'overwrite an existing config file')
    .option('-p, --path <path>', 'write the config to this path instead of the resolved default')
    .action(async (opts) => {
      const code = await runInit(opts, defaultInitDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
