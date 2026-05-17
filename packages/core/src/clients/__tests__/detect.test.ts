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

describe('detectClients', () => {
  it('returns an empty array when no client config files exist', async () => {
    const home = await makeFakeHome();
    const detected = await detectClients({ homedir: () => home, platform: 'darwin', env: {} });
    expect(detected).toEqual([]);
  });

  it('detects Claude Code when ~/.claude.json exists', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
    await fs.writeFile(configPath, '{}');

    const detected = await detectClients({ homedir: () => home, platform: 'darwin', env: {} });
    expect(detected).toEqual([{ name: 'claude', configPath }]);
  });
});
