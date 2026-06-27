import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type ToolbxConfig } from '@toolbx/core';
import type { ToolManifest } from '@toolbx/custom-tools';

import { runToolsList } from '../tools-list.js';

import { makeTempConfig, makeToolsHarness, type ConfigHarness } from './harness.js';

const harnesses: ConfigHarness[] = [];

/** A manifest entry for a custom tool, used to reconcile cached custom rows. */
function customManifest(namespace: string, name: string, enabled = true): ToolManifest {
  return {
    name,
    namespace,
    exposedName: `${namespace}__${name}`,
    title: name,
    description: name,
    entry: `tools/${namespace}/${name}.ts`,
    runtime: 'node',
    enabled,
    timeoutMs: 30_000,
    permissions: { network: false, filesystem: false, env: [] },
  };
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) {
      await h.cleanup();
    }
  }
});

function configWith(servers: ToolbxConfig['servers']): ToolbxConfig {
  return { ...DEFAULT_CONFIG, servers, tools: {} };
}

describe('runToolsList', () => {
  it('prints a table from the tool cache', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([
      {
        exposedName: 'github__create_issue',
        serverName: 'github',
        upstreamName: 'create_issue',
        tool: { name: 'github__create_issue', description: 'create a github issue' },
      },
    ]);

    const code = await runToolsList({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('EXPOSED');
    expect(h.stdout.value).toContain('github__create_issue');
    expect(h.stdout.value).toContain('yes');
  });

  it('reports a tool as disabled when an override is set', async () => {
    const cfg = await makeTempConfig({
      ...DEFAULT_CONFIG,
      servers: {
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      },
      tools: {
        github__create_issue: { enabled: false },
      },
    });
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([
      {
        exposedName: 'github__create_issue',
        serverName: 'github',
        upstreamName: 'create_issue',
        tool: { name: 'github__create_issue' },
      },
    ]);

    const code = await runToolsList({ json: true }, h.deps);

    expect(code).toBe(0);
    const payload = JSON.parse(h.stdout.value) as {
      source: string;
      tools: { exposedName: string; enabled: boolean }[];
    };
    expect(payload.source).toBe('cache');
    expect(payload.tools).toEqual([
      {
        exposedName: 'github__create_issue',
        serverName: 'github',
        upstreamName: 'create_issue',
        enabled: false,
        source: 'upstream',
      },
    ]);
  });

  it('shows the source of each tool (upstream vs custom)', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    h.deps.readToolManifest = () => Promise.resolve([customManifest('personal', 'echo')]);
    await h.writeCache([
      {
        exposedName: 'github__create_issue',
        serverName: 'github',
        upstreamName: 'create_issue',
        source: 'upstream',
        tool: { name: 'github__create_issue' },
      },
      {
        exposedName: 'personal__echo',
        serverName: 'personal',
        upstreamName: 'echo',
        source: 'custom',
        tool: { name: 'personal__echo' },
      },
    ]);

    const code = await runToolsList({}, h.deps);
    expect(code).toBe(0);
    expect(h.stdout.value).toContain('SOURCE');
    expect(h.stdout.value).toContain('custom');
    expect(h.stdout.value).toContain('upstream');
  });

  it('reflects the manifest enabled state and removal for cached custom tools', async () => {
    const cfg = await makeTempConfig(configWith({}));
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    // Manifest: echo is now disabled; greet has been removed entirely.
    h.deps.readToolManifest = () => Promise.resolve([customManifest('personal', 'echo', false)]);
    await h.writeCache([
      {
        exposedName: 'personal__echo',
        serverName: 'personal',
        upstreamName: 'echo',
        source: 'custom',
        tool: { name: 'personal__echo' },
      },
      {
        exposedName: 'personal__greet',
        serverName: 'personal',
        upstreamName: 'greet',
        source: 'custom',
        tool: { name: 'personal__greet' },
      },
    ]);

    const code = await runToolsList({ json: true }, h.deps);
    expect(code).toBe(0);
    const payload = JSON.parse(h.stdout.value) as {
      tools: { exposedName: string; enabled: boolean }[];
    };
    expect(payload.tools.map((t) => t.exposedName)).toEqual(['personal__echo']);
    expect(payload.tools[0]?.enabled).toBe(false);
  });

  it('includes the tool source in JSON output', async () => {
    const cfg = await makeTempConfig(
      configWith({ personal: { type: 'stdio', enabled: true, command: 'true', args: [] } }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    h.deps.readToolManifest = () => Promise.resolve([customManifest('personal', 'echo')]);
    await h.writeCache([
      {
        exposedName: 'personal__echo',
        serverName: 'personal',
        upstreamName: 'echo',
        source: 'custom',
        tool: { name: 'personal__echo' },
      },
    ]);

    const code = await runToolsList({ json: true }, h.deps);
    expect(code).toBe(0);
    const payload = JSON.parse(h.stdout.value) as { tools: { source: string }[] };
    expect(payload.tools[0]?.source).toBe('custom');
  });

  it('prints a guidance message when the cache is missing', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);

    const code = await runToolsList({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('No tool cache found');
    expect(h.stderr.value).toContain('--from-config');
  });

  it('--from-config lists the configured servers without touching the cache', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
        jira: {
          type: 'http',
          enabled: false,
          url: 'https://example.com/mcp',
        },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);

    const code = await runToolsList({ fromConfig: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('github');
    expect(h.stdout.value).toContain('jira');
    expect(h.stdout.value).toContain('Run `tlbx serve`');
  });

  it('--server filters cached tools to that server', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
        jira: { type: 'http', enabled: true, url: 'https://example.com/mcp' },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([
      {
        exposedName: 'github__create_issue',
        serverName: 'github',
        upstreamName: 'create_issue',
        tool: { name: 'github__create_issue' },
      },
      {
        exposedName: 'jira__search_issues',
        serverName: 'jira',
        upstreamName: 'search_issues',
        tool: { name: 'jira__search_issues' },
      },
    ]);

    const code = await runToolsList({ json: true, server: 'jira' }, h.deps);

    expect(code).toBe(0);
    const payload = JSON.parse(h.stdout.value) as {
      tools: { serverName: string }[];
    };
    expect(payload.tools.map((t) => t.serverName)).toEqual(['jira']);
  });

  it('rejects --server for an unknown server', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);

    const code = await runToolsList({ server: 'jira' }, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Unknown server or namespace "jira"');
  });

  it('--server accepts a custom-tool namespace with no upstream server entry', async () => {
    const cfg = await makeTempConfig(configWith({}));
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    h.deps.readToolManifest = () => Promise.resolve([customManifest('personal', 'echo')]);
    await h.writeCache([
      {
        exposedName: 'personal__echo',
        serverName: 'personal',
        upstreamName: 'echo',
        source: 'custom',
        tool: { name: 'personal__echo' },
      },
    ]);

    const code = await runToolsList({ json: true, server: 'personal' }, h.deps);
    expect(code).toBe(0);
    const payload = JSON.parse(h.stdout.value) as { tools: { exposedName: string }[] };
    expect(payload.tools.map((t) => t.exposedName)).toEqual(['personal__echo']);
  });

  it('--from-config honours --server and lists only that server', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
        jira: { type: 'http', enabled: true, url: 'https://example.com/mcp' },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);

    const code = await runToolsList({ fromConfig: true, server: 'jira' }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('jira');
    expect(h.stdout.value).not.toContain('github');
  });

  it('reports a filtered-out --server distinctly from an empty cache', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
        jira: { type: 'http', enabled: true, url: 'https://example.com/mcp' },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([
      {
        exposedName: 'github__create_issue',
        serverName: 'github',
        upstreamName: 'create_issue',
        tool: { name: 'github__create_issue' },
      },
    ]);

    const code = await runToolsList({ server: 'jira' }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('No tools match server "jira"');
    expect(h.stdout.value).not.toContain('Run `tlbx serve`');
  });
});
