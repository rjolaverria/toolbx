import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, saveConfig, type ToolBoxConfig } from '@toolbox/core';

import { runServerEdit, splitEditorCommand, type EditDeps } from '../server-edit.js';

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
  /** Signal that terminated the editor (when set, code is forced to null). */
  signal?: NodeJS.Signals;
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
      if (opts.signal !== undefined) {
        return { code: null, signal: opts.signal };
      }
      return { code: opts.exitCode ?? 0, signal: null };
    },
    tempFilePath: () => tempFile,
  };
  return { deps, stdout, stderr, tempFile, editorInvocations };
}

function configWith(servers: ToolBoxConfig['servers']): ToolBoxConfig {
  return { ...DEFAULT_CONFIG, servers };
}

describe('splitEditorCommand', () => {
  it('handles a bare command', () => {
    expect(splitEditorCommand('vi')).toEqual({ command: 'vi', args: [] });
  });

  it('splits a command with arguments (e.g. EDITOR="code --wait")', () => {
    expect(splitEditorCommand('code --wait')).toEqual({
      command: 'code',
      args: ['--wait'],
    });
    expect(splitEditorCommand('vim -f -p')).toEqual({
      command: 'vim',
      args: ['-f', '-p'],
    });
  });

  it('collapses surrounding and internal whitespace', () => {
    expect(splitEditorCommand('  code   --wait  ')).toEqual({
      command: 'code',
      args: ['--wait'],
    });
  });

  it('throws when the editor string is empty or whitespace-only', () => {
    expect(() => splitEditorCommand('')).toThrow();
    expect(() => splitEditorCommand('   ')).toThrow();
  });
});

describe('runServerEdit', () => {
  it('passes the temp file as the final argv to the editor command', async () => {
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

    const code = await runServerEdit('github', { editor: 'fake-editor' }, h.deps);

    expect(code).toBe(0);
    expect(h.editorInvocations).toEqual([{ editor: 'fake-editor', file: h.tempFile }]);
  });

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

  it('refuses to save when the same server changed on disk while editing', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      edit: async (file) => {
        // A valid edit to the temp file...
        await fs.writeFile(
          file,
          JSON.stringify({
            type: 'stdio',
            enabled: true,
            command: 'true',
            args: ['--from-editor'],
          }),
        );
        // ...but a concurrent command disables the same server meanwhile.
        await saveConfig(
          configWith({
            github: { type: 'stdio', enabled: false, command: 'true', args: [] },
          }),
          cfg.target,
        );
      },
    });

    const code = await runServerEdit('github', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('changed on disk while the editor was open');
    // The concurrent change survives; the editor's stale-based edit is discarded.
    const reloaded = await loadConfig(cfg.target);
    const entry = reloaded.servers['github'];
    expect(entry?.enabled).toBe(false);
    if (entry?.type === 'stdio') {
      expect(entry.args).toEqual([]);
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

  it('aborts when the editor is killed by a signal (e.g. SIGINT)', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      signal: 'SIGINT',
      // Even if the editor wrote something before being killed, we should not
      // proceed to parse/save.
      edit: async (file) => {
        await fs.writeFile(
          file,
          JSON.stringify({ type: 'stdio', enabled: false, command: 'true', args: [] }),
        );
      },
    });

    const before = await loadConfig(cfg.target);
    const code = await runServerEdit('github', {}, h.deps);
    const after = await loadConfig(cfg.target);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('SIGINT');
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
