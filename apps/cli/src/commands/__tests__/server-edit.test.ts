import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, type ToolboxConfig } from '@toolbox/core';

import { runServerEdit, type EditDeps } from '../server-edit.js';

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

interface Harness {
  deps: EditDeps;
  stdout: { value: string };
  stderr: { value: string };
  tempFile: string;
  editorInvocations: Array<{ editor: string; file: string }>;
}

interface HarnessOptions {
  /** Editor stub: receives the file path and may modify it. */
  edit?: (file: string) => Promise<void> | void;
  /** Editor exit code (default 0). */
  exitCode?: number;
  /** Throw from spawnEditor instead of returning. */
  throwOnSpawn?: Error;
}

function makeHarness(target: string, opts: HarnessOptions = {}): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const dir = path.dirname(target);
  const tempFile = path.join(dir, 'edit-stub.json');
  const editorInvocations: Array<{ editor: string; file: string }> = [];
  const deps: EditDeps = {
    resolvePath: () => target,
    cwd: () => dir,
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    resolveEditor: () => 'fake-editor',
    spawnEditor: async (editor, file) => {
      editorInvocations.push({ editor, file });
      if (opts.throwOnSpawn) {
        throw opts.throwOnSpawn;
      }
      if (opts.edit) {
        await opts.edit(file);
      }
      return opts.exitCode ?? 0;
    },
    tempFilePath: () => tempFile,
  };
  return { deps, stdout, stderr, tempFile, editorInvocations };
}

function configWith(servers: ToolboxConfig['servers']): ToolboxConfig {
  return { ...DEFAULT_CONFIG, servers };
}

describe('runServerEdit', () => {
  it('saves valid edits back to the config', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      edit: async (file) => {
        await fs.writeFile(
          file,
          JSON.stringify(
            { type: 'stdio', enabled: false, command: 'true', args: ['--flag'] },
            null,
            2,
          ),
        );
      },
    });

    const code = await runServerEdit('github', {}, h.deps);

    expect(code).toBe(0);
    expect(h.editorInvocations).toHaveLength(1);
    expect(h.editorInvocations[0]?.editor).toBe('fake-editor');
    const reloaded = await loadConfig(cfg.target);
    const entry = reloaded.servers['github'];
    expect(entry?.type).toBe('stdio');
    expect(entry?.enabled).toBe(false);
    if (entry?.type === 'stdio') {
      expect(entry.args).toEqual(['--flag']);
    }
  });

  it('rejects invalid JSON and leaves config untouched', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      edit: async (file) => {
        await fs.writeFile(file, '{ not json');
      },
    });

    const before = await loadConfig(cfg.target);
    const code = await runServerEdit('github', {}, h.deps);
    const after = await loadConfig(cfg.target);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Invalid JSON');
    expect(after).toEqual(before);
  });

  it('rejects schema-invalid edits and leaves config untouched', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      edit: async (file) => {
        await fs.writeFile(file, JSON.stringify({ type: 'stdio', enabled: 'not-a-boolean' }));
      },
    });

    const before = await loadConfig(cfg.target);
    const code = await runServerEdit('github', {}, h.deps);
    const after = await loadConfig(cfg.target);

    expect(code).toBe(1);
    expect(after).toEqual(before);
  });

  it('rejects an unknown server name', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runServerEdit('does-not-exist', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Unknown server');
    expect(h.editorInvocations).toHaveLength(0);
  });

  it('aborts when the editor exits non-zero', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { exitCode: 130 });

    const before = await loadConfig(cfg.target);
    const code = await runServerEdit('github', {}, h.deps);
    const after = await loadConfig(cfg.target);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Editor exited with code 130');
    expect(after).toEqual(before);
  });

  it('reports a clear error when the editor cannot be spawned', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { throwOnSpawn: new Error('ENOENT') });

    const code = await runServerEdit('github', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Failed to launch editor');
  });

  it('cleans up the temp file after a successful edit', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      edit: async (file) => {
        await fs.writeFile(
          file,
          JSON.stringify({ type: 'stdio', enabled: true, command: 'true', args: [] }),
        );
      },
    });

    const code = await runServerEdit('github', {}, h.deps);

    expect(code).toBe(0);
    await expect(fs.access(h.tempFile)).rejects.toThrow();
  });
});
