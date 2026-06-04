import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type ToolBoxConfig } from '@toolbox/core';
import type { ToolManifest } from '@toolbox/custom-tools';

import { runToolsSearch } from '../tools-search.js';

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

function configWith(servers: ToolBoxConfig['servers']): ToolBoxConfig {
  return { ...DEFAULT_CONFIG, servers, tools: {} };
}

describe('runToolsSearch', () => {
  it('ranks results using the same algorithm as the bootstrap search tool', async () => {
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
        tool: { name: 'github__create_issue', description: 'open a github issue' },
      },
      {
        exposedName: 'jira__search_issues',
        serverName: 'jira',
        upstreamName: 'search_issues',
        tool: { name: 'jira__search_issues', description: 'search jira issues' },
      },
    ]);

    const code = await runToolsSearch('jira', { json: true }, h.deps);

    expect(code).toBe(0);
    const rows = JSON.parse(h.stdout.value) as {
      exposedName: string;
      score: number;
    }[];
    expect(rows[0]?.exposedName).toBe('jira__search_issues');
    expect(rows[0]?.score).toBe(600); // exact-server-name band
  });

  it('honours --limit', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    await h.writeCache([
      {
        exposedName: 'github__a',
        serverName: 'github',
        upstreamName: 'a',
        tool: { name: 'github__a', description: 'issue tool a' },
      },
      {
        exposedName: 'github__b',
        serverName: 'github',
        upstreamName: 'b',
        tool: { name: 'github__b', description: 'issue tool b' },
      },
      {
        exposedName: 'github__c',
        serverName: 'github',
        upstreamName: 'c',
        tool: { name: 'github__c', description: 'issue tool c' },
      },
    ]);

    const code = await runToolsSearch('issue', { json: true, limit: 2 }, h.deps);

    expect(code).toBe(0);
    const rows = JSON.parse(h.stdout.value) as { exposedName: string }[];
    expect(rows).toHaveLength(2);
  });

  it('reports the missing cache with a help message', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);

    const code = await runToolsSearch('issue', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('No tool cache found');
  });

  it('reconciles cached custom rows against the manifest (drops removed, reflects disabled)', async () => {
    const cfg = await makeTempConfig(configWith({}));
    harnesses.push(cfg);
    const h = makeToolsHarness(cfg.target);
    // Manifest: echo is disabled; greet was removed entirely.
    h.deps.readToolManifest = () => Promise.resolve([customManifest('personal', 'echo', false)]);
    await h.writeCache([
      {
        exposedName: 'personal__echo',
        serverName: 'personal',
        upstreamName: 'echo',
        source: 'custom',
        tool: { name: 'personal__echo', description: 'echo a message' },
      },
      {
        exposedName: 'personal__greet',
        serverName: 'personal',
        upstreamName: 'greet',
        source: 'custom',
        tool: { name: 'personal__greet', description: 'greet a person' },
      },
    ]);

    const code = await runToolsSearch('a', { json: true }, h.deps);
    expect(code).toBe(0);
    const rows = JSON.parse(h.stdout.value) as {
      exposedName: string;
      enabled: boolean;
      source: string;
    }[];
    // greet was removed → absent; echo present but disabled per the manifest.
    expect(rows.map((r) => r.exposedName)).toEqual(['personal__echo']);
    expect(rows[0]?.enabled).toBe(false);
    // Source provenance is carried through search rows (parity with tools list).
    expect(rows[0]?.source).toBe('custom');
  });
});
