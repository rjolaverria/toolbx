import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicWriteFile } from '../atomic-write.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-atomic-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Temp files atomicWriteFile may leave in `dir` (it should clean them up). */
async function tmpLeftovers(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => name.includes('.tmp'));
}

describe('atomicWriteFile', () => {
  it('writes a new file and leaves no temp file behind', async () => {
    const target = path.join(dir, 'out.json');
    await atomicWriteFile(target, 'hello\n');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('hello\n');
    expect(await tmpLeftovers()).toEqual([]);
  });

  it('replaces an existing file via rename', async () => {
    const target = path.join(dir, 'out.json');
    await fs.writeFile(target, 'old', 'utf8');
    await atomicWriteFile(target, 'new');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('new');
    expect(await tmpLeftovers()).toEqual([]);
  });

  it('cleans up the temp file and rethrows when the rename fails', async () => {
    // A directory at the target path makes `rename(tmp, target)` fail; the
    // original target must be left in place and the temp file discarded.
    const target = path.join(dir, 'is-a-dir');
    await fs.mkdir(target);

    await expect(atomicWriteFile(target, 'data')).rejects.toThrow();

    expect((await fs.stat(target)).isDirectory()).toBe(true);
    expect(await tmpLeftovers()).toEqual([]);
  });
});
