import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, type ToolBoxConfig } from '@rjolaverria/toolbox-core';

import { runDisable, runEnable } from '../server-toggle.js';

import { makeHarness, makeTempConfig, type ConfigHarness } from './harness.js';

const harnesses: ConfigHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) {
      await h.cleanup();
    }
  }
});

function configWith(servers: ToolBoxConfig['servers']): ToolBoxConfig {
  return { ...DEFAULT_CONFIG, servers };
}

describe('runEnable / runDisable', () => {
  it('flips an enabled flag and persists the change', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: false, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runEnable('github', {}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('enabled');
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.servers['github']?.enabled).toBe(true);
  });

  it('disable persists enabled=false', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runDisable('github', {}, h.deps);

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.servers['github']?.enabled).toBe(false);
  });

  it('is a no-op when state already matches and reports it', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runEnable('github', {}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('already enabled');
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
    const code = await runDisable('does-not-exist', {}, h.deps);
    const after = await loadConfig(cfg.target);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Unknown server');
    expect(after).toEqual(before);
  });

  it('does not lose an update when two servers are toggled concurrently', async () => {
    // Without the shared config-dir lock these two read-modify-write cycles race
    // and one disable clobbers the other; withConfigLock makes both survive.
    const cfg = await makeTempConfig(
      configWith({
        a: { type: 'stdio', enabled: true, command: 'true', args: [] },
        b: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const [codeA, codeB] = await Promise.all([
      runDisable('a', {}, h.deps),
      runDisable('b', {}, h.deps),
    ]);

    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    const after = await loadConfig(cfg.target);
    expect(after.servers['a']?.enabled).toBe(false);
    expect(after.servers['b']?.enabled).toBe(false);
  });
});
