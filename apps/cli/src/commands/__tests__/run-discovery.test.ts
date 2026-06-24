import {
  DEFAULT_CONFIG,
  searchTools,
  type DaemonClient,
  type DaemonListToolsResult,
  type RegisteredToolView,
} from '@rjolaverria/toolbox-core';
import { BOOTSTRAP_TOOL_META_KEY, CUSTOM_TOOL_META_KEY } from '@rjolaverria/toolbox-gateway';
import { describe, expect, it, vi } from 'vitest';

import { runDiscovery } from '../run-discovery.js';
import { runRun } from '../run.js';
import { type RunDeps, type RunOptions, type RunPositionals } from '../run-shared.js';

type ListedTool = DaemonListToolsResult['tools'][number];

const DEFAULT_TOOLS: ListedTool[] = [
  {
    name: 'github__create_issue',
    title: 'Create issue',
    description: 'Create a new GitHub issue in the configured repository.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'Markdown body' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'github__list_issues',
    description: 'List issues for the repository.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'jira__search_issues',
    description: 'Search Jira issues using JQL.',
    inputSchema: {
      type: 'object',
      properties: { jql: { type: 'string' } },
      required: ['jql'],
    },
  },
  // Bootstrap tool — marked by the daemon, so it must be excluded from every
  // discovery surface regardless of its name.
  {
    name: 'toolbox__search_tools',
    description: 'Search ToolBox tools.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    _meta: { [BOOTSTRAP_TOOL_META_KEY]: true },
  },
];

interface Harness {
  deps: RunDeps;
  stdout: string;
  stderr: string;
  ensureDaemonCalls: number;
  listToolsCalls: number;
}

function makeHarness(
  opts: {
    tools?: ListedTool[];
    isStdoutTTY?: boolean;
    listToolsThrows?: Error;
    ensureDaemonFails?: { code: number; message: string };
  } = {},
): Harness {
  const tools = opts.tools ?? DEFAULT_TOOLS;
  let stdout = '';
  let stderr = '';
  let ensureDaemonCalls = 0;
  let listToolsCalls = 0;

  const client: DaemonClient = {
    listTools: () => {
      listToolsCalls++;
      if (opts.listToolsThrows) {
        return Promise.reject(opts.listToolsThrows);
      }
      return Promise.resolve({ tools });
    },
    callTool: () => Promise.reject(new Error('callTool should not run during discovery')),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const deps: RunDeps = {
    ensureDaemon: () => {
      ensureDaemonCalls++;
      if (opts.ensureDaemonFails) {
        return Promise.resolve({ ok: false, ...opts.ensureDaemonFails });
      }
      return Promise.resolve({
        ok: true,
        daemon: {
          url: 'http://127.0.0.1:7393/mcp',
          pid: 4242,
          reused: true,
          configPath: '/resolved/config.json',
          statePath: '/resolved/config.json.state',
          logPath: '/resolved/config.json.log',
          config: DEFAULT_CONFIG,
        },
      });
    },
    connect: () => Promise.resolve(client),
    readFile: () => Promise.reject(new Error('readFile should not run during discovery')),
    readStdin: () => Promise.resolve(''),
    stdout: (msg) => {
      stdout += msg;
    },
    stderr: (msg) => {
      stderr += msg;
    },
    isStdoutTTY: opts.isStdoutTTY ?? true,
    sleep: () => Promise.resolve(),
    now: () => 0,
  };

  return {
    deps,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get ensureDaemonCalls() {
      return ensureDaemonCalls;
    },
    get listToolsCalls() {
      return listToolsCalls;
    },
  };
}

function discover(pos: RunPositionals, options: RunOptions, harness: Harness): Promise<number> {
  return runDiscovery(pos, options, harness.deps);
}

describe('runDiscovery — list', () => {
  it('lists every enabled tool and excludes bootstrap tools', async () => {
    const h = makeHarness();
    const code = await discover({}, { list: true, output: 'json' }, h);
    expect(code).toBe(0);
    const rows = JSON.parse(h.stdout) as { exposedName: string; enabled: boolean }[];
    expect(rows.map((r) => r.exposedName)).toEqual([
      'github__create_issue',
      'github__list_issues',
      'jira__search_issues',
    ]);
    expect(rows.every((r) => r.enabled)).toBe(true);
    expect(h.ensureDaemonCalls).toBe(1);
  });

  it('scopes the listing to a server filter', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'github' }, { list: true, output: 'json' }, h);
    expect(code).toBe(0);
    const rows = JSON.parse(h.stdout) as { serverName: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.serverName === 'github')).toBe(true);
  });

  it('reports an empty server filter clearly in text mode', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'linear' }, { list: true }, h);
    expect(code).toBe(0);
    expect(h.stdout).toMatch(/no enabled tools for server "linear"/i);
  });

  it('renders exposed name, server, tool, enabled, and description columns in text mode', async () => {
    const h = makeHarness();
    const code = await discover({}, { list: true }, h);
    expect(code).toBe(0);
    expect(h.stdout).toMatch(/EXPOSED\s+SERVER\s+TOOL\s+ENABLED\s+SOURCE\s+DESCRIPTION/);
    expect(h.stdout).toContain('github__create_issue');
    expect(h.stdout).toContain('Create a new GitHub issue');
    expect(h.stdout).not.toContain('toolbox__search_tools');
  });

  it('labels custom tools with source "custom" in list output', async () => {
    const h = makeHarness({
      tools: [
        {
          name: 'github__create_issue',
          description: 'Create a GitHub issue.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'personal__echo',
          description: 'Echo a message.',
          inputSchema: { type: 'object', properties: {}, required: [] },
          _meta: { [CUSTOM_TOOL_META_KEY]: true },
        },
      ],
    });

    const code = await discover({}, { list: true, output: 'json' }, h);
    expect(code).toBe(0);
    const rows = JSON.parse(h.stdout) as { exposedName: string; source: string }[];
    expect(rows.find((r) => r.exposedName === 'personal__echo')?.source).toBe('custom');
    expect(rows.find((r) => r.exposedName === 'github__create_issue')?.source).toBe('upstream');
  });

  it('shows the source column for a custom tool in text list output', async () => {
    const h = makeHarness({
      tools: [
        {
          name: 'personal__echo',
          description: 'Echo a message.',
          inputSchema: { type: 'object', properties: {}, required: [] },
          _meta: { [CUSTOM_TOOL_META_KEY]: true },
        },
      ],
    });
    const code = await discover({}, { list: true }, h);
    expect(code).toBe(0);
    expect(h.stdout).toContain('custom');
  });

  it('keeps an unmarked upstream tool that shares a bootstrap name', async () => {
    // A server literally named `toolbox` with bootstrap tools disabled: the
    // daemon lists `toolbox__search_tools` without the bootstrap marker, so it
    // is a normal, callable upstream tool that discovery must surface.
    const h = makeHarness({
      tools: [
        {
          name: 'toolbox__search_tools',
          description: 'A real upstream search tool.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ],
    });
    const code = await discover({}, { list: true, output: 'json' }, h);
    expect(code).toBe(0);
    const rows = JSON.parse(h.stdout) as { exposedName: string }[];
    expect(rows.map((r) => r.exposedName)).toEqual(['toolbox__search_tools']);
  });

  it('rejects a tool positional with a usage error', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'github', tool: 'create_issue' }, { list: true }, h);
    expect(code).toBe(2);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/server name, not a tool/i);
  });

  it('rejects a fully exposed name as the server filter before contacting the daemon', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'github__create_issue' }, { list: true }, h);
    expect(code).toBe(2);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/looks like a tool name/i);
  });
});

describe('runDiscovery — search', () => {
  it('ranks matches with the same ordering as the shared search engine', async () => {
    const h = makeHarness();
    const code = await discover({}, { search: 'issue', output: 'json' }, h);
    expect(code).toBe(0);
    const rows = JSON.parse(h.stdout) as { exposedName: string }[];

    const views: RegisteredToolView[] = DEFAULT_TOOLS.filter(
      (t) => t.name !== 'toolbox__search_tools',
    ).map((t) => {
      const [serverName, ...rest] = t.name.split('__');
      return {
        exposedName: t.name,
        serverName: serverName ?? '',
        upstreamName: rest.join('__'),
        tool: t,
      };
    });
    const expected = searchTools('issue', views).map((hit) => hit.tool.exposedName);
    expect(rows.map((r) => r.exposedName)).toEqual(expected);
    expect(rows.map((r) => r.exposedName)).not.toContain('toolbox__search_tools');
  });

  it('scopes search to a server filter', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'jira' }, { search: 'issue', output: 'json' }, h);
    expect(code).toBe(0);
    const rows = JSON.parse(h.stdout) as { serverName: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.serverName === 'jira')).toBe(true);
  });

  it('reports no matches in text mode', async () => {
    const h = makeHarness();
    const code = await discover({}, { search: 'nonexistent-zzz' }, h);
    expect(code).toBe(0);
    expect(h.stdout).toMatch(/no matches/i);
  });

  it('rejects an empty query before contacting the daemon', async () => {
    const h = makeHarness();
    const code = await discover({}, { search: '   ' }, h);
    expect(code).toBe(2);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/non-empty query/i);
  });

  it('honors --limit', async () => {
    const h = makeHarness();
    const code = await discover({}, { search: 'issue', limit: 1, output: 'json' }, h);
    expect(code).toBe(0);
    const rows = JSON.parse(h.stdout) as unknown[];
    expect(rows).toHaveLength(1);
  });
});

describe('runDiscovery — describe', () => {
  it('shows title, description, required and optional fields, and an example command', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'github', tool: 'create_issue' }, { describe: true }, h);
    expect(code).toBe(0);
    expect(h.stdout).toContain('github__create_issue');
    expect(h.stdout).toContain('Create issue');
    expect(h.stdout).toMatch(/Required:/);
    expect(h.stdout).toMatch(/title \(string\) — The issue title/);
    expect(h.stdout).toMatch(/Optional:/);
    expect(h.stdout).toMatch(/body \(string\)/);
    expect(h.stdout).toMatch(/tlbx run github__create_issue --json/);
  });

  it('emits structured describe data in JSON mode', async () => {
    const h = makeHarness();
    const code = await discover(
      { target: 'github__create_issue' },
      { describe: true, output: 'json' },
      h,
    );
    expect(code).toBe(0);
    const payload = JSON.parse(h.stdout) as {
      required: { name: string }[];
      optional: { name: string }[];
      example: { command: string; arguments: Record<string, unknown> };
    };
    expect(payload.required.map((f) => f.name)).toEqual(['title']);
    expect(payload.optional.map((f) => f.name).sort()).toEqual(['body', 'labels']);
    expect(payload.example.command).toMatch(/^tlbx run github__create_issue --json /);
  });

  it('needs a tool target', async () => {
    const h = makeHarness();
    const code = await discover({}, { describe: true }, h);
    expect(code).toBe(2);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/needs a tool/i);
  });

  it('shell-escapes single quotes in the example command', async () => {
    const h = makeHarness({
      tools: [
        {
          name: 'custom__quote',
          inputSchema: {
            type: 'object',
            properties: { phrase: { type: 'string', default: "it's a trap" } },
            required: [],
          },
        },
      ],
    });
    const code = await discover({ target: 'custom', tool: 'quote' }, { describe: true }, h);
    expect(code).toBe(0);
    // The embedded `'` is escaped as `'\''`, leaving a single safe shell word.
    expect(h.stdout).toContain(`--json '{"phrase":"it'\\''s a trap"}'`);
  });

  it('shell-quotes a tool name that is not shell-safe', async () => {
    const h = makeHarness({
      tools: [
        {
          name: 'custom__odd name',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ],
    });
    const code = await discover(
      { target: 'custom__odd name' },
      { describe: true, output: 'json' },
      h,
    );
    expect(code).toBe(0);
    const payload = JSON.parse(h.stdout) as { example: { command: string } };
    expect(payload.example.command).toBe(`tlbx run 'custom__odd name' --json '{}'`);
  });
});

describe('runDiscovery — schema', () => {
  it('prints the raw input schema as valid JSON', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'jira', tool: 'search_issues' }, { schema: true }, h);
    expect(code).toBe(0);
    const schema = JSON.parse(h.stdout) as { type: string; required: string[] };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['jql']);
  });
});

describe('runDiscovery — example', () => {
  it('emits a valid JSON skeleton for an object schema', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'github', tool: 'create_issue' }, { example: true }, h);
    expect(code).toBe(0);
    const skeleton = JSON.parse(h.stdout) as Record<string, unknown>;
    expect(skeleton).toEqual({ title: '', body: '', labels: [''] });
  });

  it('falls back to a placeholder marker for an untyped field', async () => {
    const h = makeHarness({
      tools: [
        {
          name: 'custom__weird',
          inputSchema: {
            type: 'object',
            properties: { anything: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
            required: [],
          },
        },
      ],
    });
    const code = await discover({ target: 'custom', tool: 'weird' }, { example: true }, h);
    expect(code).toBe(0);
    const skeleton = JSON.parse(h.stdout) as Record<string, unknown>;
    expect(skeleton.anything).toBe('<unsupported>');
  });
});

describe('runDiscovery — unknown tool', () => {
  it('errors with nearby matches and exit 4', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'github', tool: 'create_issu' }, { describe: true }, h);
    expect(code).toBe(4);
    expect(h.stderr).toMatch(/unknown tool "github__create_issu"/i);
    expect(h.stderr).toMatch(/did you mean/i);
    expect(h.stderr).toContain('github__create_issue');
  });

  it('errors without suggestions when nothing is close', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'zzz', tool: 'qqq' }, { schema: true }, h);
    expect(code).toBe(4);
    expect(h.stderr).toMatch(/unknown tool "zzz__qqq"/i);
    expect(h.stderr).toMatch(/tlbx run --list/);
  });
});

describe('runDiscovery — flag validation', () => {
  it('rejects two discovery flags at once', async () => {
    const h = makeHarness();
    const code = await discover({}, { list: true, search: 'x' }, h);
    expect(code).toBe(2);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/mutually exclusive/i);
  });

  it('rejects combining discovery with tool input', async () => {
    const h = makeHarness();
    const code = await discover({ target: 'github' }, { list: true, json: '{}' }, h);
    expect(code).toBe(2);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/take no tool input/i);
  });

  it('rejects --output mcp for discovery before contacting the daemon', async () => {
    const h = makeHarness();
    const code = await discover({}, { list: true, output: 'mcp' }, h);
    expect(code).toBe(2);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/mcp is not supported for discovery/i);
  });

  it('surfaces daemon failures as exit 3', async () => {
    const h = makeHarness({ ensureDaemonFails: { code: 3, message: 'daemon down' } });
    const code = await discover({}, { list: true }, h);
    expect(code).toBe(3);
    expect(h.stderr).toMatch(/daemon down/);
  });
});

describe('runRun — dispatches discovery flags', () => {
  it('routes --list through discovery instead of executing a tool', async () => {
    const h = makeHarness();
    const code = await runRun({}, { list: true, output: 'json' }, h.deps);
    expect(code).toBe(0);
    expect(h.listToolsCalls).toBe(1);
  });

  it('rejects --limit without --search before contacting the daemon', async () => {
    const h = makeHarness();
    const code = await runRun({ target: 'github__create_issue' }, { limit: 5 }, h.deps);
    expect(code).toBe(2);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/--limit only applies to --search/i);
  });
});
