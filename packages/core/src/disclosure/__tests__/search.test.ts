import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import type { RegisteredToolView } from '../../proxy/registry-view.js';
import { searchTools, type SearchMatchedField } from '../search.js';

interface MakeToolInput {
  readonly serverName: string;
  readonly upstreamName: string;
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Record<string, { description?: string }>;
}

function makeTool(input: MakeToolInput): RegisteredToolView {
  const exposedName = `${input.serverName}__${input.upstreamName}`;
  const inputSchema: Tool['inputSchema'] = {
    type: 'object',
    properties: input.properties ?? {},
  };
  const tool: Tool = {
    name: exposedName,
    inputSchema,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  return {
    exposedName,
    serverName: input.serverName,
    upstreamName: input.upstreamName,
    tool,
  };
}

const FIXTURES: readonly RegisteredToolView[] = [
  makeTool({
    serverName: 'github',
    upstreamName: 'create_issue',
    title: 'Create Issue',
    description: 'Create a new issue in a repository',
    properties: {
      owner: { description: 'The repository owner login' },
      title: { description: 'Issue headline' },
    },
  }),
  makeTool({
    serverName: 'github',
    upstreamName: 'list_repos',
    description: 'List repositories owned by the authenticated user',
    properties: {
      visibility: { description: 'public, private, or all' },
    },
  }),
  makeTool({
    serverName: 'jira',
    upstreamName: 'search_issues',
    description: 'Search Jira issues using JQL',
    properties: {
      jql: { description: 'A JQL query string' },
    },
  }),
  makeTool({
    serverName: 'linear',
    upstreamName: 'create_issue',
    description: 'Create a Linear ticket',
  }),
  makeTool({
    serverName: 'aaa',
    upstreamName: 'tie',
    description: 'first alphabetical tie candidate',
  }),
  makeTool({
    serverName: 'aab',
    upstreamName: 'tie',
    description: 'second alphabetical tie candidate',
  }),
];

describe('searchTools — empty input', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['punctuation only', '!!!'],
  ])('returns [] for %s', (_label, query) => {
    expect(searchTools(query, FIXTURES)).toEqual([]);
  });

  it('returns [] when no tools are provided', () => {
    expect(searchTools('github', [])).toEqual([]);
  });
});

describe('searchTools — band 1 exact server match', () => {
  it('promotes every tool from the matching server above all others', () => {
    const results = searchTools('github', FIXTURES);
    const githubExposed = FIXTURES.filter((t) => t.serverName === 'github').map(
      (t) => t.exposedName,
    );
    const topTwo = results.slice(0, githubExposed.length).map((r) => r.tool.exposedName);
    expect(topTwo.sort()).toEqual(githubExposed.sort());
    for (const r of results.slice(0, githubExposed.length)) {
      expect(r.score).toBe(600);
      expect(r.matchedFields).toEqual(['serverName']);
    }
  });

  it('is case-insensitive on the server name', () => {
    const results = searchTools('GITHUB', FIXTURES);
    expect(results[0]?.score).toBe(600);
  });
});

describe('searchTools — band 2 exact exposed name match', () => {
  it('ranks the exact exposed name first when no server name matches', () => {
    const results = searchTools('jira__search_issues', FIXTURES);
    expect(results[0]?.tool.exposedName).toBe('jira__search_issues');
    expect(results[0]?.score).toBe(500);
    expect(results[0]?.matchedFields).toEqual(['exposedName']);
  });
});

describe('searchTools — band 3 exact tool name and title', () => {
  it('matches by upstream tool name', () => {
    const results = searchTools('search_issues', FIXTURES);
    expect(results[0]?.tool.exposedName).toBe('jira__search_issues');
    expect(results[0]?.score).toBe(400);
    expect(results[0]?.matchedFields).toEqual(['toolName']);
  });

  it('matches by title and reports both fields when both equal the query', () => {
    // 'create issue' equals the title but not the upstream name (`create_issue`),
    // because the tokenizer is for keyword bands, not exact-equality bands.
    const titleOnly = searchTools('create issue', FIXTURES);
    const githubCreate = titleOnly.find((r) => r.tool.exposedName === 'github__create_issue');
    expect(githubCreate?.score).toBe(400);
    expect(githubCreate?.matchedFields).toEqual(['toolTitle']);
  });

  it('returns multiple tools that share the same upstream name, tie-broken alphabetically', () => {
    const results = searchTools('create_issue', FIXTURES);
    const exposed = results.filter((r) => r.score === 400).map((r) => r.tool.exposedName);
    expect(exposed).toEqual(['github__create_issue', 'linear__create_issue']);
  });
});

describe('searchTools — band 4 description and tag keywords', () => {
  it('matches when every query token is a substring of the description', () => {
    // 'authenticated' only appears in github__list_repos' description, and not
    // in any name, schema, or other field — so it lands cleanly in band 4.
    const results = searchTools('authenticated', FIXTURES);
    expect(results[0]?.tool.exposedName).toBe('github__list_repos');
    expect(results[0]?.score).toBe(300);
    expect(results[0]?.matchedFields).toEqual(['description']);
  });

  it('matches via tags supplied through tagsByExposedName', () => {
    const results = searchTools('payments', FIXTURES, {
      tagsByExposedName: {
        linear__create_issue: ['payments', 'billing'],
      },
    });
    const linear = results.find((r) => r.tool.exposedName === 'linear__create_issue');
    expect(linear?.score).toBe(300);
    expect(linear?.matchedFields).toEqual(['tags']);
  });

  it('requires every token to match (AND semantics) for the description band', () => {
    // 'jql' matches jira__search_issues' description; 'github' does not.
    // Without all tokens present, the tool falls through to band 6.
    const results = searchTools('jql github', FIXTURES);
    const jira = results.find((r) => r.tool.exposedName === 'jira__search_issues');
    expect(jira?.score).toBe(100);
  });
});

describe('searchTools — band 5 input schema keywords', () => {
  it('matches a tool whose only hit is on a schema property name', () => {
    const results = searchTools('jql', FIXTURES);
    // `jql` appears in jira__search_issues' description AND its property name;
    // description match is a higher band so it wins. Use a query that only
    // hits the schema:
    const visibility = searchTools('visibility', FIXTURES);
    expect(visibility[0]?.tool.exposedName).toBe('github__list_repos');
    expect(visibility[0]?.score).toBe(200);
    expect(visibility[0]?.matchedFields).toEqual(['inputSchema']);
    // And confirm the keyword-overlap behavior with `jql`:
    expect(results[0]?.tool.exposedName).toBe('jira__search_issues');
  });
});

describe('searchTools — band 6 fuzzy substring fallback', () => {
  it('catches partial matches that fall through every higher band', () => {
    // A bare-bones tool with no description and no schema; the only place
    // 'crea' can match is the upstream tool name (and the exposed name).
    const minimal = makeTool({ serverName: 'minimal', upstreamName: 'create_one' });
    const results = searchTools('crea', [minimal]);
    expect(results[0]?.score).toBe(100);
    expect(results[0]?.matchedFields).toContain('toolName');
  });

  it('ranks fuzzy hits below every exact band', () => {
    // 'crea' substring-matches several things in FIXTURES but exactly equals
    // nothing — so the highest score in the result set must be band 4 (300)
    // or below. (github__create_issue's description includes 'create'.)
    const results = searchTools('crea', FIXTURES);
    expect(results[0]?.score).toBeLessThanOrEqual(300);
  });

  it('does not false-match a trailing-separator query against band 2', () => {
    const results = searchTools('github__', FIXTURES);
    for (const r of results) {
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });
});

describe('searchTools — tie-breaker', () => {
  it('orders equal scores alphabetically by exposed name (byte order)', () => {
    const results = searchTools('tie', FIXTURES);
    const exposed = results.filter((r) => r.score === 400).map((r) => r.tool.exposedName);
    expect(exposed).toEqual(['aaa__tie', 'aab__tie']);
  });
});

describe('searchTools — limit option', () => {
  it('truncates to options.limit', () => {
    const results = searchTools('github', FIXTURES, { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('defaults to 20 when limit is omitted', () => {
    const many: RegisteredToolView[] = [];
    for (let i = 0; i < 25; i++) {
      const idx = i.toString().padStart(2, '0');
      many.push(
        makeTool({
          serverName: 'bulk',
          upstreamName: `tool_${idx}`,
        }),
      );
    }
    const results = searchTools('bulk', many);
    expect(results).toHaveLength(20);
  });
});

describe('searchTools — missing fields', () => {
  it('does not throw when description and schema are absent', () => {
    const tool = makeTool({ serverName: 'minimal', upstreamName: 'noop' });
    const results = searchTools('minimal', [tool]);
    expect(results[0]?.score).toBe(600);
  });

  it('reports matchedFields in the canonical enum order', () => {
    const order: SearchMatchedField[] = [
      'serverName',
      'exposedName',
      'toolName',
      'toolTitle',
      'description',
      'inputSchema',
      'tags',
    ];
    // 'thi' substring-hits exposedName, toolName, and toolTitle (band 6).
    const tool = makeTool({
      serverName: 'svc',
      upstreamName: 'svc_thing',
      title: 'SVC Thing',
    });
    const results = searchTools('thi', [tool]);
    const matched = results[0]?.matchedFields ?? [];
    expect(matched.length).toBeGreaterThan(1);
    const indexes = matched.map((field) => order.indexOf(field));
    const sorted = [...indexes].sort((a, b) => a - b);
    expect(indexes).toEqual(sorted);
  });
});

describe('searchTools — determinism', () => {
  it('produces identical results across repeated calls', () => {
    const a = searchTools('issue', FIXTURES);
    const b = searchTools('issue', FIXTURES);
    expect(a).toEqual(b);
  });
});
