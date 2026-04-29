import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../defaults.js';
import { loadConfig } from '../load.js';
import { saveConfig } from '../save.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

describe('saveConfig', () => {
  it('round-trips through loadConfig', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'config.json');
    await saveConfig(DEFAULT_CONFIG, file);
    const loaded = await loadConfig(file);
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });

  it('preserves the $schema field byte-for-byte in the saved file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'config.json');
    await saveConfig(DEFAULT_CONFIG, file);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).toContain('"$schema": "https://toolbox.dev/schema/config.schema.json"');
  });

  it('creates missing parent directories', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'nested', 'a', 'b', 'config.json');
    await saveConfig(DEFAULT_CONFIG, file);
    const stat = await fs.stat(file);
    expect(stat.isFile()).toBe(true);
  });

  it('writes a trailing newline', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'config.json');
    await saveConfig(DEFAULT_CONFIG, file);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('leaves no .tmp artifacts behind on success', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'config.json');
    await saveConfig(DEFAULT_CONFIG, file);
    const entries = await fs.readdir(dir);
    const leftover = entries.filter((name) => name.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });

  it('overwrites an existing config file in place', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'config.json');
    await saveConfig(DEFAULT_CONFIG, file);

    const updated = {
      ...DEFAULT_CONFIG,
      servers: {
        ...DEFAULT_CONFIG.servers,
        github: {
          type: 'stdio' as const,
          enabled: true,
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      },
    };
    await saveConfig(updated, file);

    const loaded = await loadConfig(file);
    expect(loaded).toEqual(updated);

    const entries = await fs.readdir(dir);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('cleans up the .tmp file when the rename target is unwritable', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'config.json');
    await saveConfig(DEFAULT_CONFIG, file);
    // Make the existing target a directory so a rename onto it fails.
    await fs.rm(file);
    await fs.mkdir(file);
    await fs.mkdir(path.join(file, 'occupant'));

    await expect(saveConfig(DEFAULT_CONFIG, file)).rejects.toBeInstanceOf(Error);

    const entries = await fs.readdir(dir);
    const leftoverTmp = entries.filter((name) => name.endsWith('.tmp'));
    expect(leftoverTmp).toEqual([]);
  });
});
