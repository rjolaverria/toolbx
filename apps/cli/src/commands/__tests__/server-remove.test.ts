import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  type ToolBoxConfig,
} from '@rjolaverria/toolbox-core';

import { runServerRemove, type RemoveDeps } from '../server-remove.js';

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
  deps: RemoveDeps;
  stdout: { value: string };
  stderr: { value: string };
  prompts: string[];
}

interface HarnessOptions {
  isTty?: boolean;
  confirmAnswer?: boolean;
}

function makeHarness(target: string, opts: HarnessOptions = {}): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const prompts: string[] = [];
  const deps: RemoveDeps = {
    resolvePath: () => target,
    cwd: () => path.dirname(target),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    isTty: () => opts.isTty ?? true,
    confirm: async (question) => {
      prompts.push(question);
      return Promise.resolve(opts.confirmAnswer ?? false);
    },
  };
  return { deps, stdout, stderr, prompts };
}

function configWith(servers: ToolBoxConfig['servers']): ToolBoxConfig {
  return { ...DEFAULT_CONFIG, servers };
}

describe('runServerRemove', () => {
  it('removes the entry when --yes is passed', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
        linear: { type: 'http', enabled: true, url: 'https://example.com/mcp' },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runServerRemove('github', { yes: true }, h.deps);

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.servers['github']).toBeUndefined();
    expect(reloaded.servers['linear']).toBeDefined();
    expect(h.prompts).toEqual([]);
  });

  it('rejects an unknown server and does not modify config', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const before = await loadConfig(cfg.target);
    const code = await runServerRemove('does-not-exist', { yes: true }, h.deps);
    const after = await loadConfig(cfg.target);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Unknown server');
    expect(after).toEqual(before);
  });

  it('exits 2 in a non-TTY without --yes', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { isTty: false });

    const before = await loadConfig(cfg.target);
    const code = await runServerRemove('github', {}, h.deps);
    const after = await loadConfig(cfg.target);

    expect(code).toBe(2);
    expect(h.stderr.value).toContain('--yes');
    expect(after).toEqual(before);
  });

  it('aborts when the user declines the prompt', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { isTty: true, confirmAnswer: false });

    const before = await loadConfig(cfg.target);
    const code = await runServerRemove('github', {}, h.deps);
    const after = await loadConfig(cfg.target);

    expect(code).toBe(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.stderr.value).toContain('Aborted');
    expect(after).toEqual(before);
  });

  it('removes when the user accepts the prompt', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { isTty: true, confirmAnswer: true });

    const code = await runServerRemove('github', {}, h.deps);

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.servers['github']).toBeUndefined();
  });

  it('refuses to remove when the server entry changed during the prompt', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);
    // A concurrent edit to the same server while the prompt is open: the user
    // confirmed removal of the old entry, so removal must abort.
    h.deps.confirm = async () => {
      await saveConfig(
        configWith({
          github: { type: 'stdio', enabled: false, command: 'true', args: ['--changed'] },
        }),
        cfg.target,
      );
      return true;
    };

    const code = await runServerRemove('github', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('changed on disk since you were prompted');
    // The concurrently-edited server is preserved, not removed.
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.servers['github']).toBeDefined();
  });
});
