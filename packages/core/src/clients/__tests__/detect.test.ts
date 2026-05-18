import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectClients } from '../detect.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
});

async function makeFakeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-detect-clients-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeClaudeConfig(home: string): Promise<string> {
  const configPath = path.join(home, '.claude.json');
  await fs.writeFile(configPath, '{}');
  return configPath;
}

async function writeCodexConfig(home: string): Promise<string> {
  const dir = path.join(home, '.codex');
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, 'config.toml');
  await fs.writeFile(configPath, '');
  return configPath;
}

async function writeOpencodeConfig(home: string): Promise<string> {
  const dir = path.join(home, '.config', 'opencode');
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, 'opencode.json');
  await fs.writeFile(configPath, '{}');
  return configPath;
}

describe('detectClients', () => {
  it('returns an empty array when no client config files exist', async () => {
    const home = await makeFakeHome();
    const detected = await detectClients({ homedir: () => home, platform: 'darwin', env: {} });
    expect(detected).toEqual([]);
  });

  it('detects Claude Code when ~/.claude.json exists', async () => {
    const home = await makeFakeHome();
    const configPath = await writeClaudeConfig(home);

    const detected = await detectClients({ homedir: () => home, platform: 'darwin', env: {} });
    expect(detected).toEqual([{ name: 'claude', configPath }]);
  });

  it('detects Codex when ~/.codex/config.toml exists', async () => {
    const home = await makeFakeHome();
    const configPath = await writeCodexConfig(home);

    const detected = await detectClients({ homedir: () => home, platform: 'darwin', env: {} });
    expect(detected).toEqual([{ name: 'codex', configPath }]);
  });

  it('detects OpenCode when ~/.config/opencode/opencode.json exists', async () => {
    const home = await makeFakeHome();
    const configPath = await writeOpencodeConfig(home);

    const detected = await detectClients({ homedir: () => home, platform: 'darwin', env: {} });
    expect(detected).toEqual([{ name: 'opencode', configPath }]);
  });

  it('detects all three clients when all configs exist', async () => {
    const home = await makeFakeHome();
    const claudePath = await writeClaudeConfig(home);
    const codexPath = await writeCodexConfig(home);
    const opencodePath = await writeOpencodeConfig(home);

    const detected = await detectClients({ homedir: () => home, platform: 'darwin', env: {} });
    expect(detected).toEqual([
      { name: 'claude', configPath: claudePath },
      { name: 'codex', configPath: codexPath },
      { name: 'opencode', configPath: opencodePath },
    ]);
  });

  it('tolerates one adapter throwing and still reports the others', async () => {
    // A self-pointing symlink at the Claude config path makes `fs.stat`
    // throw ELOOP — neither ENOENT (the "absent" signal the adapter
    // tolerates) nor a successful stat. Without per-adapter tolerance,
    // `detectClients` would let that throw bubble out and skip the codex
    // and opencode probes entirely.
    const home = await makeFakeHome();
    const codexPath = await writeCodexConfig(home);
    const opencodePath = await writeOpencodeConfig(home);
    const claudePath = path.join(home, '.claude.json');
    await fs.symlink(claudePath, claudePath);

    const detected = await detectClients({ homedir: () => home, platform: 'darwin', env: {} });

    expect(detected).toEqual([
      { name: 'codex', configPath: codexPath },
      { name: 'opencode', configPath: opencodePath },
    ]);
  });
});
