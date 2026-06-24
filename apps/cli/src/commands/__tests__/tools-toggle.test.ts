import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, type ToolBoxConfig } from '@rjolaverria/toolbox-core';

import { runToolsDisable, runToolsEnable } from '../tools-toggle.js';

import { makeTempConfig, makeToolsHarness, type ConfigHarness } from './harness.js';

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
  return { ...DEFAULT_CONFIG, servers, tools: {} };
}

async function configFixture(): Promise<ConfigHarness> {
  return makeTempConfig(
    configWith({
      github: { type: 'stdio', enabled: true, command: 'true', args: [] },
    }),
  );
}

const githubCacheEntry = {
  exposedName: 'github__create_issue',
  serverName: 'github',
  upstreamName: 'create_issue',
  tool: { name: 'github__create_issue' },
};

describe('runToolsDisable / runToolsEnable', () => {
  it('disable writes a tools[exposedName].enabled=false override', async () => {
    const cfg = await configFixture();
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([githubCacheEntry]);

    const code = await runToolsDisable('github/create_issue', {}, h.deps);

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.tools['github__create_issue']).toEqual({ enabled: false });
  });

  it('accepts the namespace__tool form', async () => {
    const cfg = await configFixture();
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([githubCacheEntry]);

    const code = await runToolsDisable('github__create_issue', {}, h.deps);

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.tools['github__create_issue']).toEqual({ enabled: false });
  });

  it('enable clears a previous disable override rather than persist a tautology', async () => {
    const cfg = await makeTempConfig({
      ...DEFAULT_CONFIG,
      servers: {
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      },
      tools: { github__create_issue: { enabled: false } },
    });
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([githubCacheEntry]);

    const code = await runToolsEnable('github/create_issue', {}, h.deps);

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.tools).toEqual({});
  });

  it('reports already-disabled as a no-op', async () => {
    const cfg = await makeTempConfig({
      ...DEFAULT_CONFIG,
      servers: {
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      },
      tools: { github__create_issue: { enabled: false } },
    });
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([githubCacheEntry]);

    const code = await runToolsDisable('github/create_issue', {}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('already disabled');
  });

  it('rejects a tool name not present in the cache', async () => {
    const cfg = await configFixture();
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([githubCacheEntry]);

    const before = await loadConfig(cfg.target);
    const code = await runToolsDisable('github/does_not_exist', {}, h.deps);
    const after = await loadConfig(cfg.target);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Unknown tool');
    expect(after).toEqual(before);
  });

  it('rejects an unknown server', async () => {
    const cfg = await configFixture();
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([githubCacheEntry]);

    const code = await runToolsDisable('jira/search_issues', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Unknown server "jira"');
  });

  it('rejects a slash reference whose namespace contains the separator', async () => {
    const cfg = await configFixture();
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([githubCacheEntry]);

    const code = await runToolsDisable('github__create_issue/extra', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('namespace containing');
  });

  it('accepts a slash reference whose upstream tool name contains the separator', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    // Upstream tool whose own name contains `__` — the slash form should
    // honour the boundary at the `/`, not at the `__`.
    await h.writeCache([
      {
        exposedName: 'github__create__issue',
        serverName: 'github',
        upstreamName: 'create__issue',
        tool: { name: 'github__create__issue' },
      },
    ]);

    const code = await runToolsDisable('github/create__issue', {}, h.deps);

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.tools['github__create__issue']).toEqual({ enabled: false });
  });

  it('allows disabling before the cache exists with a forward-compatible override', async () => {
    const cfg = await configFixture();
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);

    const code = await runToolsDisable('github/create_issue', {}, h.deps);

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.tools['github__create_issue']).toEqual({ enabled: false });
  });
});
