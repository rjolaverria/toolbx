import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type ToolBoxConfig } from '@toolbox/core';

import { runToolsSearch } from '../tools-search.js';

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
});
