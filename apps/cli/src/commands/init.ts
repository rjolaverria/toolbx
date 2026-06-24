import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

import { Command } from '@commander-js/extra-typings';
import { DEFAULT_CONFIG, resolveConfigPath, saveConfig } from '@rjolaverria/toolbox-core';

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
 *
 * Race-safe: uses `open(O_EXCL)` to create the file, so a concurrent process
 * that wrote `target` between the initial stat and our create cannot have
 * its work overwritten — we observe `EEXIST`, treat the run as
 * `created: false`, and leave the racing writer's content untouched.
 */
export async function createConfigIfMissing(target: string): Promise<CreateConfigIfMissingResult> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const payload = JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n';

  try {
    const handle = await fs.open(target, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { created: true, path: target };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  // Something is at `target` (either pre-existing or written by a race
  // winner). Re-check that it is actually a regular file before reporting
  // success — a directory or device node still needs to be surfaced.
  const stat = await fs.stat(target);
  if (!stat.isFile()) {
    throw new Error(`Cannot use ${target}: not a regular file.`);
  }
  return { created: false, path: target };
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
