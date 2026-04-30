import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_CONFIG, saveConfig, type ToolboxConfig } from '@toolbox/core';

import type { ServerCommandDeps } from '../server-shared.js';

export interface ConfigHarness {
  target: string;
  dir: string;
  cleanup: () => Promise<void>;
}

export async function makeTempConfig(
  initial: ToolboxConfig = DEFAULT_CONFIG,
): Promise<ConfigHarness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-cli-server-'));
  const target = path.join(dir, 'config.json');
  await saveConfig(initial, target);
  return {
    target,
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export interface CommandHarness {
  deps: ServerCommandDeps;
  stdout: { value: string };
  stderr: { value: string };
}

export function makeHarness(target: string): CommandHarness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const deps: ServerCommandDeps = {
    resolvePath: () => target,
    cwd: () => path.dirname(target),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
  };
  return { deps, stdout, stderr };
}
