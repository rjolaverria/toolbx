import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createNoopLogger,
  DEFAULT_CONFIG,
  InMemoryTokenStore,
  saveConfig,
  writeToolCache,
  type CachedTool,
  type ToolBoxConfig,
} from '@toolbox/core';

import type { AuthCommandDeps } from '../auth/shared.js';
import type { ServerCommandDeps } from '../server-shared.js';
import type { ToolsCommandDeps } from '../tools-shared.js';

export interface ConfigHarness {
  target: string;
  dir: string;
  cleanup: () => Promise<void>;
}

export async function makeTempConfig(
  initial: ToolBoxConfig = DEFAULT_CONFIG,
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

export interface AuthCommandHarness {
  deps: AuthCommandDeps;
  store: InMemoryTokenStore;
  stdout: { value: string };
  stderr: { value: string };
}

/**
 * Auth-command deps wired against an in-memory token store. The OAuth
 * orchestrators (`runOAuthLogin` / `runOAuthRefresh`) default to throwing so a
 * test that forgets to stub them fails loudly; each test reassigns the field it
 * exercises with a `vi.fn`.
 */
export function makeAuthHarness(
  target: string,
  store: InMemoryTokenStore = new InMemoryTokenStore(),
): AuthCommandHarness {
  const base = makeHarness(target);
  const deps: AuthCommandDeps = {
    ...base.deps,
    logger: createNoopLogger(),
    createTokenStore: () => store,
    // Default to an OAuth hint with no resource-metadata URL so the common case
    // exercises origin-based discovery; tests that care override this.
    probeAuth: () => Promise.resolve({ kind: 'oauth' }),
    runOAuthLogin: () => Promise.reject(new Error('runOAuthLogin not stubbed')),
    runOAuthRefresh: () => Promise.reject(new Error('runOAuthRefresh not stubbed')),
  };
  return { deps, store, stdout: base.stdout, stderr: base.stderr };
}

export interface ToolsCommandHarness {
  deps: ToolsCommandDeps;
  stdout: { value: string };
  stderr: { value: string };
  cachePath: string;
  writeCache: (tools: readonly CachedTool[]) => Promise<void>;
}

export function makeToolsHarness(target: string): ToolsCommandHarness {
  const base = makeHarness(target);
  const cachePath = path.join(path.dirname(target), 'tools-cache.json');
  const deps: ToolsCommandDeps = {
    ...base.deps,
    resolveCachePath: () => cachePath,
  };
  return {
    deps,
    stdout: base.stdout,
    stderr: base.stderr,
    cachePath,
    writeCache: (tools) =>
      writeToolCache({ tools, now: new Date('2026-05-09T00:00:00Z') }, cachePath),
  };
}
