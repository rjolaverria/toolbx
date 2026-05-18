import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  runInstallFlow,
  type InstallFlowMergeResult,
  type InternalInstallFlowHooks,
} from '../install-flow.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
});

async function makeTmpFile(initial: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-install-flow-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.cfg');
  await fs.writeFile(file, initial);
  return file;
}

describe('runInstallFlow', () => {
  it('writes nextContent atomically and produces a backup with the original inode', async () => {
    const file = await makeTmpFile('old\n');
    const originalInode = (await fs.stat(file)).ino;

    const result = await runInstallFlow({
      configPath: file,
      opts: { dryRun: false, force: false },
      hooks: {},
      merge: () => ({
        ok: true,
        status: 'installed',
        nextContent: 'new\n',
        diff: '+ new',
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('installed');
    expect(result.diff).toBe('+ new');
    expect(result.backupPath).toBeDefined();
    expect(await fs.readFile(file, 'utf8')).toBe('new\n');
    if (result.backupPath) {
      expect((await fs.stat(result.backupPath)).ino).toBe(originalInode);
      expect((await fs.stat(file)).ino).not.toBe(originalInode);
      expect(await fs.readFile(result.backupPath, 'utf8')).toBe('old\n');
    }
  });

  it('returns the already-installed status without writing or backing up', async () => {
    const file = await makeTmpFile('intact\n');
    const originalBytes = await fs.readFile(file);

    const result = await runInstallFlow({
      configPath: file,
      opts: { dryRun: false, force: false },
      hooks: {},
      merge: () => ({ ok: true, status: 'already-installed', diff: '' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('already-installed');
    expect(result.backupPath).toBeUndefined();
    expect(await fs.readFile(file)).toEqual(originalBytes);
    const entries = await fs.readdir(path.dirname(file));
    expect(entries.filter((e) => e.includes('.bak.'))).toEqual([]);
  });

  it('dryRun returns the diff without touching disk', async () => {
    const file = await makeTmpFile('old\n');
    const before = await fs.readFile(file);
    const beforeEntries = await fs.readdir(path.dirname(file));

    const result = await runInstallFlow({
      configPath: file,
      opts: { dryRun: true, force: false },
      hooks: {},
      merge: () => ({
        ok: true,
        status: 'installed',
        nextContent: 'new\n',
        diff: '+ diff',
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('installed');
    expect(result.diff).toBe('+ diff');
    expect(result.backupPath).toBeUndefined();
    expect(await fs.readFile(file)).toEqual(before);
    expect(await fs.readdir(path.dirname(file))).toEqual(beforeEntries);
  });

  it('propagates a merge ok:false result without writing', async () => {
    const file = await makeTmpFile('intact\n');
    const before = await fs.readFile(file);

    const result = await runInstallFlow({
      configPath: file,
      opts: { dryRun: false, force: false },
      hooks: {},
      merge: () => ({ ok: false, reason: 'malformed', hint: 'fix the file' }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('malformed');
    expect(result.hint).toBe('fix the file');
    expect(await fs.readFile(file)).toEqual(before);
    const entries = await fs.readdir(path.dirname(file));
    expect(entries.filter((e) => e.includes('.bak.'))).toEqual([]);
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('aborts when the file content changes between read and verify (same length)', async () => {
    const file = await makeTmpFile('aaa');
    const hooks: InternalInstallFlowHooks = {
      afterTmpWrite: async () => {
        await fs.writeFile(file, 'bbb');
      },
    };

    const result = await runInstallFlow({
      configPath: file,
      opts: { dryRun: false, force: false },
      hooks,
      merge: () => ({
        ok: true,
        status: 'installed',
        nextContent: 'next\n',
        diff: '+',
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/modified/i);
    expect(await fs.readFile(file, 'utf8')).toBe('bbb');
    const entries = await fs.readdir(path.dirname(file));
    expect(entries.filter((e) => e.includes('.bak.'))).toEqual([]);
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('refuses to clobber a file that reappears between rename and link', async () => {
    const file = await makeTmpFile('orig\n');
    const concurrentContent = 'other-process\n';
    const hooks: InternalInstallFlowHooks = {
      afterMoveOriginalToBackup: async () => {
        await fs.writeFile(file, concurrentContent, { flag: 'wx' });
      },
    };

    const result = await runInstallFlow({
      configPath: file,
      opts: { dryRun: false, force: false },
      hooks,
      merge: () => ({
        ok: true,
        status: 'installed',
        nextContent: 'merged\n',
        diff: '+',
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/another process/i);
    expect(result.hint).toContain('.bak.');
    expect(await fs.readFile(file, 'utf8')).toBe(concurrentContent);
    const entries = await fs.readdir(path.dirname(file));
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
    expect(entries.filter((e) => e.includes('.bak.')).length).toBe(1);
  });

  it('rolls back when the afterMoveOriginalToBackup hook throws (file existed)', async () => {
    // Exercises the rollback branch where the original was already on disk
    // before install: backup → restore on hook error, surface the thrown
    // error, leave no tmp/bak debris behind.
    const file = await makeTmpFile('original\n');
    const originalBytes = await fs.readFile(file);

    const hooks: InternalInstallFlowHooks = {
      afterMoveOriginalToBackup: () => {
        return Promise.reject(new Error('simulated hook failure'));
      },
    };

    await expect(
      runInstallFlow({
        configPath: file,
        opts: { dryRun: false, force: false },
        hooks,
        merge: () => ({
          ok: true,
          status: 'installed',
          nextContent: 'next\n',
          diff: '+ next',
        }),
      }),
    ).rejects.toThrow(/simulated hook failure/);

    // Original content restored from backup; no tmp or bak leaked.
    expect(await fs.readFile(file)).toEqual(originalBytes);
    const entries = await fs.readdir(path.dirname(file));
    expect(entries.filter((e) => e.includes('.bak.'))).toEqual([]);
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('passes exists:false to merge when the config file is absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-install-flow-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const missing = path.join(dir, 'does-not-exist.cfg');

    let observedExists: boolean | undefined;
    const result = await runInstallFlow({
      configPath: missing,
      opts: { dryRun: false, force: false },
      hooks: {},
      merge: (input): InstallFlowMergeResult => {
        observedExists = input.exists;
        return { ok: false, reason: 'config not found', hint: 'create it' };
      },
    });

    expect(observedExists).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('config not found');
  });
});
