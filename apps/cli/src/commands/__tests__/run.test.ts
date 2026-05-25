import type { DaemonCallToolResult, DaemonClient, DaemonListToolsResult } from '@toolbox/core';
import { describe, expect, it, vi } from 'vitest';

import { runRun, type RunDeps, type RunOptions, type RunPositionals } from '../run.js';

interface ToolStub {
  name: string;
  empty?: boolean;
}

interface Harness {
  deps: RunDeps;
  ensureDaemonCalls: number;
  connectCalls: string[];
  callToolCalls: { name: string; arguments: Record<string, unknown> | undefined }[];
  stdout: string;
  stderr: string;
}

function makeHarness(
  opts: {
    tools?: ToolStub[];
    callResult?: DaemonCallToolResult;
    ensureDaemonFails?: { code: number; message: string };
    stdin?: string;
    files?: Record<string, string>;
  } = {},
): Harness {
  const tools = opts.tools ?? [{ name: 'github__create_issue' }];
  const listResult: DaemonListToolsResult = {
    tools: tools.map((t) => ({
      name: t.name,
      inputSchema: t.empty
        ? { type: 'object' as const, properties: {}, required: [] }
        : {
            type: 'object' as const,
            properties: { title: { type: 'string' } },
            required: ['title'],
          },
    })),
  };

  const callToolCalls: { name: string; arguments: Record<string, unknown> | undefined }[] = [];
  const connectCalls: string[] = [];
  let ensureDaemonCalls = 0;
  let stdout = '';
  let stderr = '';

  const client: DaemonClient = {
    listTools: () => Promise.resolve(listResult),
    callTool: (params) => {
      callToolCalls.push({ name: params.name, arguments: params.arguments });
      return Promise.resolve(
        opts.callResult ?? { content: [{ type: 'text', text: 'Created issue #1' }] },
      );
    },
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
        },
      });
    },
    connect: (url) => {
      connectCalls.push(url);
      return Promise.resolve(client);
    },
    readFile: (p) => {
      const content = opts.files?.[p];
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${p}`));
      }
      return Promise.resolve(content);
    },
    readStdin: () => Promise.resolve(opts.stdin ?? ''),
    stdout: (msg) => {
      stdout += msg;
    },
    stderr: (msg) => {
      stderr += msg;
    },
  };

  return {
    deps,
    get ensureDaemonCalls() {
      return ensureDaemonCalls;
    },
    connectCalls,
    callToolCalls,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function run(pos: RunPositionals, options: RunOptions, harness: Harness): Promise<number> {
  return runRun(pos, options, harness.deps);
}

describe('runRun — target parsing', () => {
  it('joins two positionals into a namespaced exposed name', async () => {
    const h = makeHarness();
    const code = await run(
      { target: 'github', tool: 'create_issue' },
      { json: '{"title":"Bug"}' },
      h,
    );
    expect(code).toBe(0);
    expect(h.callToolCalls).toEqual([
      { name: 'github__create_issue', arguments: { title: 'Bug' } },
    ]);
  });

  it('accepts a fully exposed name as a single positional', async () => {
    const h = makeHarness();
    const code = await run({ target: 'github__create_issue' }, { json: '{"title":"Bug"}' }, h);
    expect(code).toBe(0);
    expect(h.callToolCalls[0]?.name).toBe('github__create_issue');
  });
});

describe('runRun — input modes', () => {
  it('rejects combining --json and --stdin before contacting the daemon', async () => {
    const h = makeHarness();
    const code = await run({ target: 'github__create_issue' }, { json: '{}', stdin: true }, h);
    expect(code).not.toBe(0);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/mutually exclusive|only one/i);
  });

  it('rejects combining --json and --file', async () => {
    const h = makeHarness();
    const code = await run({ target: 'github__create_issue' }, { json: '{}', file: 'in.json' }, h);
    expect(code).not.toBe(0);
    expect(h.ensureDaemonCalls).toBe(0);
  });

  it('exits nonzero on invalid JSON before contacting the daemon', async () => {
    const h = makeHarness();
    const code = await run({ target: 'github__create_issue' }, { json: '{not json' }, h);
    expect(code).not.toBe(0);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/json/i);
  });

  it('rejects JSON input that is not an object', async () => {
    const h = makeHarness();
    const code = await run({ target: 'github__create_issue' }, { json: '"hello"' }, h);
    expect(code).not.toBe(0);
    expect(h.ensureDaemonCalls).toBe(0);
  });

  it('reads arguments from a file', async () => {
    const h = makeHarness({ files: { 'in.json': '{"title":"FromFile"}' } });
    const code = await run({ target: 'github__create_issue' }, { file: 'in.json' }, h);
    expect(code).toBe(0);
    expect(h.callToolCalls[0]?.arguments).toEqual({ title: 'FromFile' });
  });

  it('reads arguments from stdin', async () => {
    const h = makeHarness({ stdin: '{"title":"FromStdin"}' });
    const code = await run({ target: 'github__create_issue' }, { stdin: true }, h);
    expect(code).toBe(0);
    expect(h.callToolCalls[0]?.arguments).toEqual({ title: 'FromStdin' });
  });
});

describe('runRun — empty-input handling', () => {
  it('calls a tool with an empty input schema and no input mode', async () => {
    const h = makeHarness({ tools: [{ name: 'github__whoami', empty: true }] });
    const code = await run({ target: 'github__whoami' }, {}, h);
    expect(code).toBe(0);
    expect(h.callToolCalls).toEqual([{ name: 'github__whoami', arguments: {} }]);
  });

  it('requires an input mode for a tool with a non-empty input schema', async () => {
    const h = makeHarness({ tools: [{ name: 'github__create_issue' }] });
    const code = await run({ target: 'github__create_issue' }, {}, h);
    expect(code).not.toBe(0);
    expect(h.callToolCalls).toHaveLength(0);
    expect(h.stderr).toMatch(/input|--json/i);
  });
});

describe('runRun — daemon invocation', () => {
  it('connects to the daemon URL returned by ensureDaemon', async () => {
    const h = makeHarness({ tools: [{ name: 'github__whoami', empty: true }] });
    await run({ target: 'github__whoami' }, {}, h);
    expect(h.connectCalls).toEqual(['http://127.0.0.1:7393/mcp']);
  });

  it('surfaces an ensureDaemon failure on stderr and never connects', async () => {
    const h = makeHarness({ ensureDaemonFails: { code: 1, message: 'tlbx run: boom' } });
    const code = await run({ target: 'github__whoami' }, { json: '{}' }, h);
    expect(code).toBe(1);
    expect(h.connectCalls).toHaveLength(0);
    expect(h.stderr).toContain('tlbx run: boom');
  });

  it('fails when the resolved tool is not exposed by the daemon', async () => {
    const h = makeHarness({ tools: [{ name: 'github__create_issue' }] });
    const code = await run({ target: 'github', tool: 'nope' }, { json: '{}' }, h);
    expect(code).not.toBe(0);
    expect(h.callToolCalls).toHaveLength(0);
    expect(h.stderr).toMatch(/github__nope|unknown/i);
  });

  it('prints the tool text result to stdout on success', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: { content: [{ type: 'text', text: 'octocat' }] },
    });
    const code = await run({ target: 'github__whoami' }, {}, h);
    expect(code).toBe(0);
    expect(h.stdout).toContain('octocat');
  });

  it('exits nonzero when the tool result is an error', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: { isError: true, content: [{ type: 'text', text: 'upstream said no' }] },
    });
    const code = await run({ target: 'github__whoami' }, {}, h);
    expect(code).not.toBe(0);
    expect(h.stderr).toContain('upstream said no');
  });
});
