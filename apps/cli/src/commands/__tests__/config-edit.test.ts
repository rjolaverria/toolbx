import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, saveConfig } from '@toolbx/core';

import { runConfigEdit, type ConfigEditDeps } from '../config-edit.js';

import { makeTempConfig, type ConfigHarness } from './harness.js';

const harnesses: ConfigHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) {
      await h.cleanup();
    }
  }
});

interface HarnessOptions {
  edit?: (file: string) => Promise<void> | void;
  exitCode?: number;
  signal?: NodeJS.Signals;
  throwOnSpawn?: Error;
  resolveEditor?: () => string;
  platform?: NodeJS.Platform;
}

interface Harness {
  deps: ConfigEditDeps;
  stdout: { value: string };
  stderr: { value: string };
  tempFile: string;
  invocations: Array<{ editor: string; file: string }>;
}

function makeHarness(target: string, opts: HarnessOptions = {}): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const dir = path.dirname(target);
  const tempFile = path.join(dir, 'config-edit-stub.json');
  const invocations: Array<{ editor: string; file: string }> = [];
  const deps: ConfigEditDeps = {
    resolvePath: () => target,
    cwd: () => dir,
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    resolveEditor: opts.resolveEditor ?? (() => 'fake-editor'),
    spawnEditor: async (editor, file) => {
      invocations.push({ editor, file });
      if (opts.throwOnSpawn) {
        throw opts.throwOnSpawn;
      }
      if (opts.edit) {
        await opts.edit(file);
      }
      if (opts.signal !== undefined) {
        return { code: null, signal: opts.signal };
      }
      return { code: opts.exitCode ?? 0, signal: null };
    },
    tempFilePath: () => tempFile,
    platform: () => opts.platform ?? 'linux',
  };
  return { deps, stdout, stderr, tempFile, invocations };
}

describe('runConfigEdit', () => {
  it('saves a valid edit back to the config file', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      edit: async (file) => {
        const next = {
          ...DEFAULT_CONFIG,
          progressiveDisclosure: { ...DEFAULT_CONFIG.progressiveDisclosure, enabled: false },
        };
        await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
      },
    });

    const code = await runConfigEdit({}, h.deps);

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.progressiveDisclosure.enabled).toBe(false);
  });

  it('refuses to save when the config changed on disk while the editor was open', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      edit: async (file) => {
        // Write a valid edit to the editor's temp file...
        const edited = {
          ...DEFAULT_CONFIG,
          progressiveDisclosure: { ...DEFAULT_CONFIG.progressiveDisclosure, enabled: false },
        };
        await fs.writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);
        // ...but simulate a concurrent command changing the on-disk config
        // while the editor session is open.
        const concurrent = {
          ...DEFAULT_CONFIG,
          servers: {
            other: { type: 'stdio' as const, enabled: true, command: 'true', args: [] },
          },
        };
        await saveConfig(concurrent, cfg.target);
      },
    });

    const code = await runConfigEdit({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('changed on disk while the editor was open');
    // The concurrent change is preserved, not clobbered by the editor snapshot.
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.servers['other']?.enabled).toBe(true);
    expect(reloaded.progressiveDisclosure.enabled).toBe(true);
  });

  it('refuses to save invalid JSON and leaves config untouched', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const before = await fs.readFile(cfg.target, 'utf8');
    const h = makeHarness(cfg.target, {
      edit: async (file) => {
        await fs.writeFile(file, '{ this is not json');
      },
    });

    const code = await runConfigEdit({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Refusing to save');
    const after = await fs.readFile(cfg.target, 'utf8');
    expect(after).toBe(before);
  });

  it('refuses to save schema-invalid JSON and leaves config untouched', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const before = await fs.readFile(cfg.target, 'utf8');
    const h = makeHarness(cfg.target, {
      edit: async (file) => {
        await fs.writeFile(file, JSON.stringify({ version: 1 }));
      },
    });

    const code = await runConfigEdit({}, h.deps);

    expect(code).toBe(1);
    const after = await fs.readFile(cfg.target, 'utf8');
    expect(after).toBe(before);
  });

  it('aborts when editor exits non-zero', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const before = await fs.readFile(cfg.target, 'utf8');
    const h = makeHarness(cfg.target, { exitCode: 2 });

    const code = await runConfigEdit({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Editor exited with code 2');
    const after = await fs.readFile(cfg.target, 'utf8');
    expect(after).toBe(before);
  });

  it('aborts when editor is killed by signal', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { signal: 'SIGINT' });

    const code = await runConfigEdit({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('SIGINT');
  });

  it('reports when the editor cannot be launched', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { throwOnSpawn: new Error('ENOENT') });

    const code = await runConfigEdit({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Failed to launch editor');
  });

  it('exits cleanly when the user makes no changes', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const before = await fs.readFile(cfg.target, 'utf8');
    const h = makeHarness(cfg.target, {
      edit: async () => {
        // no edits
      },
    });

    const code = await runConfigEdit({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('No changes');
    const after = await fs.readFile(cfg.target, 'utf8');
    expect(after).toBe(before);
  });

  it('reports a missing config and refuses to write one', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    await fs.unlink(cfg.target);
    const h = makeHarness(cfg.target);

    const code = await runConfigEdit({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('No Toolbx config found');
    expect(h.invocations).toHaveLength(0);
  });

  it('honors --editor over the resolver', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    let resolverCalls = 0;
    const h = makeHarness(cfg.target, {
      resolveEditor: () => {
        resolverCalls += 1;
        return 'should-not-be-used';
      },
      edit: async () => {
        // no edits
      },
    });

    const code = await runConfigEdit({ editor: 'override-editor' }, h.deps);

    expect(code).toBe(0);
    expect(resolverCalls).toBe(0);
    expect(h.invocations[0]?.editor).toBe('override-editor');
  });

  it('falls back to vi when EDITOR is unset on POSIX (default deps)', async () => {
    const previous = process.env['EDITOR'];
    delete process.env['EDITOR'];
    try {
      const { defaultConfigEditDeps } = await import('../config-edit.js');
      const deps = defaultConfigEditDeps();
      const editor = deps.resolveEditor();
      if (deps.platform() !== 'win32') {
        expect(editor).toBe('vi');
      }
    } finally {
      if (previous !== undefined) {
        process.env['EDITOR'] = previous;
      }
    }
  });

  it('cleans up the temp file after a successful run', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      edit: async () => {
        // unchanged
      },
    });

    const code = await runConfigEdit({}, h.deps);

    expect(code).toBe(0);
    await expect(fs.access(h.tempFile)).rejects.toThrow();
  });

  // Ensure we exercise saveConfig as a side-effect of a real edit (i.e. with
  // a mutated source) — verifies validation gates the write.
  it('persists the validated parsed object (atomic write)', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    // Force a difference by saving a reformatted version first.
    await saveConfig(DEFAULT_CONFIG, cfg.target);
    const h = makeHarness(cfg.target, {
      edit: async (file) => {
        const next = { ...DEFAULT_CONFIG };
        await fs.writeFile(file, `${JSON.stringify(next, null, 4)}\n`);
      },
    });

    const code = await runConfigEdit({}, h.deps);
    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded).toEqual(DEFAULT_CONFIG);
  });
});
