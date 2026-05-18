import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
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

async function statIfExists(target: string): Promise<Stats | null> {
  try {
    return await fs.stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export interface CreateConfigIfMissingResult {
  readonly created: boolean;
  readonly path: string;
}

/**
 * Idempotent: write the default config to `target` only when nothing is there.
 * Surfaces `created` so callers (e.g. `tlbx setup`) can tailor the first-run
 * message without having to probe the file system themselves.
 */
export async function createConfigIfMissing(target: string): Promise<CreateConfigIfMissingResult> {
  const existing = await statIfExists(target);
  if (existing !== null) {
    if (!existing.isFile()) {
      throw new Error(`Cannot use ${target}: not a regular file.`);
    }
    return { created: false, path: target };
  }
  await saveConfig(DEFAULT_CONFIG, target);
  return { created: true, path: target };
}

export async function runInit(options: InitOptions, deps: InitDeps): Promise<number> {
  const target =
    options.path !== undefined && options.path.length > 0
      ? path.resolve(deps.cwd(), options.path)
      : deps.resolvePath();

  const existing = await statIfExists(target);
  if (existing !== null) {
    if (options.force !== true) {
      deps.stderr(`Config already exists at ${target}. Re-run with --force to overwrite.\n`);
      return 1;
    }
    if (!existing.isFile()) {
      deps.stderr(`Cannot overwrite ${target}: not a regular file.\n`);
      return 1;
    }
  }

  await saveConfig(DEFAULT_CONFIG, target);
  deps.stdout(`Created ToolBox config at ${target}\n`);
  deps.stdout('Next: run `tlbx serve` to start the gateway.\n');
  return 0;
}

export function initCommand(): Command {
  return new Command('init')
    .description('Create a new ToolBox config file at the resolved location.')
    .option('-f, --force', 'overwrite an existing config file')
    .option('-p, --path <path>', 'write the config to this path instead of the resolved default')
    .action(async (opts) => {
      const code = await runInit(opts, defaultInitDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
