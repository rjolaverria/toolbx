import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { withCredentialLock } from '../lock.js';

const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-cred-lock-'));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

describe('withCredentialLock', () => {
  it('serializes concurrent calls for the same server name', async () => {
    const dir = await makeDir();
    let active = 0;
    let maxActive = 0;
    const task = (): Promise<void> =>
      withCredentialLock(dir, 'acme', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
      });

    await Promise.all([task(), task(), task()]);

    expect(maxActive).toBe(1);
  });

  it('runs calls for different server names concurrently', async () => {
    const dir = await makeDir();
    let active = 0;
    let maxActive = 0;
    const task = (name: string): Promise<void> =>
      withCredentialLock(dir, name, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
      });

    await Promise.all([task('a'), task('b'), task('c')]);

    expect(maxActive).toBeGreaterThan(1);
  });

  it('locks under a sha256-named subdir of .credentials', async () => {
    const dir = await makeDir();
    const key = createHash('sha256').update('acme', 'utf8').digest('hex');
    let lockPresent = false;

    await withCredentialLock(dir, 'acme', async () => {
      lockPresent = await fs
        .stat(path.join(dir, '.credentials', key, '.lock'))
        .then(() => true)
        .catch(() => false);
    });

    expect(lockPresent).toBe(true);
  });
});
