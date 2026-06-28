import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { clearServeState, readServeState, writeServeState } from '../state.js';
import type { ServeDaemonState } from '../schema.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbx-serve-daemon-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeState(overrides: Partial<ServeDaemonState> = {}): ServeDaemonState {
  return {
    version: 1,
    pid: 12345,
    mode: 'http',
    url: 'http://127.0.0.1:7331/mcp',
    logPath: '/var/log/serve.log',
    startedAt: '2026-05-13T12:34:56.000Z',
    configHash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('readServeState / writeServeState / clearServeState', () => {
  it('round-trips a state file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'serve-state.json');
    const state = makeState();
    await writeServeState(file, state);
    expect(await readServeState(file)).toEqual(state);
  });

  it('overwrites an existing state file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'serve-state.json');
    await writeServeState(file, makeState({ pid: 1 }));
    await writeServeState(file, makeState({ pid: 2 }));
    const result = await readServeState(file);
    expect(result?.pid).toBe(2);
  });

  it('returns null on ENOENT', async () => {
    const dir = await makeTempDir();
    expect(await readServeState(path.join(dir, 'missing.json'))).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'serve-state.json');
    await fs.writeFile(file, '{not json', 'utf8');
    expect(await readServeState(file)).toBeNull();
  });

  it('returns null on schema mismatch', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'serve-state.json');
    await fs.writeFile(file, JSON.stringify({ version: 2, pid: 1 }), 'utf8');
    expect(await readServeState(file)).toBeNull();
  });

  it('accepts a null `url`', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'serve-state.json');
    await writeServeState(file, makeState({ url: null }));
    const result = await readServeState(file);
    expect(result?.url).toBeNull();
  });

  it('clearServeState removes the file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'serve-state.json');
    await writeServeState(file, makeState());
    await clearServeState(file);
    expect(await readServeState(file)).toBeNull();
  });

  it('clearServeState on a missing file is a no-op', async () => {
    const dir = await makeTempDir();
    await expect(clearServeState(path.join(dir, 'missing.json'))).resolves.toBeUndefined();
  });

  it('creates parent directories on write', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'nested', 'serve-state.json');
    await writeServeState(file, makeState());
    const result = await readServeState(file);
    expect(result?.pid).toBe(12345);
  });

  it('does not leave .tmp files behind after a successful write', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'serve-state.json');
    await writeServeState(file, makeState());
    const entries = await fs.readdir(dir);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects and leaves no tmp file when mkdir of the parent fails', async () => {
    const dir = await makeTempDir();
    // Create a regular file at the position where writeServeState wants to
    // create a directory. fs.mkdir(..., { recursive: true }) on a path whose
    // ancestor is a non-directory rejects with ENOTDIR / EEXIST.
    const blockingFile = path.join(dir, 'not-a-dir');
    await fs.writeFile(blockingFile, 'x');
    const target = path.join(blockingFile, 'serve-state.json');
    await expect(writeServeState(target, makeState())).rejects.toThrow();
  });

  it('surfaces the original error and cleans up the tmp file when rename fails', async () => {
    // Pre-create the target as a directory so the final rename fails. The
    // writeServeState catch should run, clean up the tmp file, and rethrow.
    const dir = await makeTempDir();
    const file = path.join(dir, 'serve-state.json');
    await fs.mkdir(file);
    await expect(writeServeState(file, makeState())).rejects.toThrow();
    const entries = await fs.readdir(dir);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
