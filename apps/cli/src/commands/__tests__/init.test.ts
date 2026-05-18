import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig } from '@toolbox/core';

import { createConfigIfMissing, runInit, type InitDeps } from '../init.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-cli-init-'));
  tempDirs.push(dir);
  return dir;
}

interface Harness {
  deps: InitDeps;
  stdout: { value: string };
  stderr: { value: string };
  resolveCalls: { count: number };
}

function makeHarness(resolved: string, cwd?: string): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const resolveCalls = { count: 0 };
  const deps: InitDeps = {
    resolvePath: () => {
      resolveCalls.count += 1;
      return resolved;
    },
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    cwd: () => cwd ?? process.cwd(),
  };
  return { deps, stdout, stderr, resolveCalls };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

describe('runInit', () => {
  it('writes a valid default config to the resolved path on a fresh machine', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'config.json');
    const h = makeHarness(target);

    const code = await runInit({}, h.deps);

    expect(code).toBe(0);
    const loaded = await loadConfig(target);
    expect(loaded).toEqual(DEFAULT_CONFIG);
    expect(h.stdout.value).toContain(target);
    expect(h.stdout.value).toContain('tlbx serve');
    expect(h.stderr.value).toBe('');
  });

  it('refuses to overwrite an existing config without --force', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'config.json');
    const sentinel = 'sentinel\n';
    await fs.writeFile(target, sentinel, 'utf8');
    const h = makeHarness(target);

    const code = await runInit({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('--force');
    expect(h.stderr.value).toContain(target);
    expect(await fs.readFile(target, 'utf8')).toBe(sentinel);
  });

  it('overwrites the existing config when --force is set', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'config.json');
    await fs.writeFile(target, 'sentinel\n', 'utf8');
    const h = makeHarness(target);

    const code = await runInit({ force: true }, h.deps);

    expect(code).toBe(0);
    const loaded = await loadConfig(target);
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });

  it('honors --path over the resolved default', async () => {
    const dir = await makeTempDir();
    const ignored = path.join(dir, 'should-not-be-used.json');
    const target = path.join(dir, 'custom', 'config.json');
    const h = makeHarness(ignored);

    const code = await runInit({ path: target }, h.deps);

    expect(code).toBe(0);
    expect(h.resolveCalls.count).toBe(0);
    const loaded = await loadConfig(target);
    expect(loaded).toEqual(DEFAULT_CONFIG);
    await expect(fs.stat(ignored)).rejects.toThrow();
  });

  it('resolves a relative --path against the provided cwd', async () => {
    const dir = await makeTempDir();
    const ignored = path.join(dir, 'should-not-be-used.json');
    const h = makeHarness(ignored, dir);

    const code = await runInit({ path: 'nested/config.json' }, h.deps);

    expect(code).toBe(0);
    const target = path.join(dir, 'nested', 'config.json');
    const loaded = await loadConfig(target);
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });

  it('refuses to overwrite a directory at the target path even with --force', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'config.json');
    await fs.mkdir(target);
    const h = makeHarness(target);

    const code = await runInit({ force: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('not a regular file');
    const stat = await fs.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });

  it('creates missing parent directories', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'a', 'b', 'c', 'config.json');
    const h = makeHarness(target);

    const code = await runInit({}, h.deps);

    expect(code).toBe(0);
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
  });
});

describe('createConfigIfMissing', () => {
  it('writes the default config when the path does not exist', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'config.json');

    const result = await createConfigIfMissing(target);

    expect(result).toEqual({ created: true, path: target });
    const loaded = await loadConfig(target);
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });

  it('leaves an existing file untouched and reports created=false', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'config.json');
    const initial = '{ "version": 1, "servers": {} }\n';
    await fs.writeFile(target, initial, 'utf8');

    const result = await createConfigIfMissing(target);

    expect(result).toEqual({ created: false, path: target });
    expect(await fs.readFile(target, 'utf8')).toBe(initial);
  });

  it('rejects a non-regular-file at the target path', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'config.json');
    await fs.mkdir(target);

    await expect(createConfigIfMissing(target)).rejects.toThrow(/not a regular file/);
  });

  it('preserves an existing file when a racing writer wins the create', async () => {
    // Simulate the TOCTOU race by pre-creating the target with content a
    // process other than us would have written. `createConfigIfMissing` must
    // return `{ created: false }` and leave the file byte-identical instead
    // of overwriting it with DEFAULT_CONFIG.
    const dir = await makeTempDir();
    const target = path.join(dir, 'config.json');
    const otherWriterContent = '{"version":1,"servers":{"sentinel-from-race":{}}}\n';
    await fs.writeFile(target, otherWriterContent, 'utf8');

    const result = await createConfigIfMissing(target);

    expect(result.created).toBe(false);
    expect(await fs.readFile(target, 'utf8')).toBe(otherWriterContent);
  });

  it('creates missing parent directories before writing', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'nested', 'config.json');

    const result = await createConfigIfMissing(target);

    expect(result.created).toBe(true);
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
  });
});
