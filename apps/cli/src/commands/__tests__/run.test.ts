import {
  authExpiredMeta,
  type DaemonCallToolResult,
  type DaemonClient,
  type DaemonListToolsResult,
} from '@toolbox/core';
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
    connectThrows?: Error;
    listToolsThrows?: Error;
    callToolThrows?: Error;
    stdin?: string;
    files?: Record<string, string>;
    isStdoutTTY?: boolean;
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
    listTools: () =>
      opts.listToolsThrows ? Promise.reject(opts.listToolsThrows) : Promise.resolve(listResult),
    callTool: (params) => {
      callToolCalls.push({ name: params.name, arguments: params.arguments });
      if (opts.callToolThrows !== undefined) {
        return Promise.reject(opts.callToolThrows);
      }
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
      if (opts.connectThrows) {
        return Promise.reject(opts.connectThrows);
      }
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
    isStdoutTTY: opts.isStdoutTTY ?? true,
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

  it('maps an ensureDaemon failure to the daemon exit code and never connects', async () => {
    const h = makeHarness({ ensureDaemonFails: { code: 1, message: 'tlbx run: boom' } });
    const code = await run({ target: 'github__whoami' }, { json: '{}' }, h);
    expect(code).toBe(3);
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

describe('runRun — output modes', () => {
  const ok = (text: string): DaemonCallToolResult => ({ content: [{ type: 'text', text }] });

  it('text mode prints only the joined text content to stdout', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: ok('octocat'),
    });
    const code = await run({ target: 'github__whoami' }, { output: 'text' }, h);
    expect(code).toBe(0);
    expect(h.stdout).toBe('octocat\n');
    expect(h.stderr).toBe('');
  });

  it('text mode falls back to compact JSON for non-text content', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: { content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] },
    });
    const code = await run({ target: 'github__whoami' }, { output: 'text' }, h);
    expect(code).toBe(0);
    expect(h.stdout).toMatchInlineSnapshot(`
      "[{"type":"image","data":"abc","mimeType":"image/png"}]
      "
    `);
  });

  it('json mode wraps a successful result in the agent-stable envelope', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__create_issue' }],
      callResult: ok('Created issue #123'),
    });
    const code = await run(
      { target: 'github', tool: 'create_issue' },
      { output: 'json', json: '{"title":"Bug"}' },
      h,
    );
    expect(code).toBe(0);
    expect(h.stdout).toMatchInlineSnapshot(`
      "{
        "ok": true,
        "server": "github",
        "tool": "create_issue",
        "exposedName": "github__create_issue",
        "result": {
          "content": [
            {
              "type": "text",
              "text": "Created issue #123"
            }
          ]
        }
      }
      "
    `);
    expect(h.stderr).toBe('');
  });

  it('json mode decomposes a fully exposed name into server and tool', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: ok('octocat'),
    });
    await run({ target: 'github__whoami' }, { output: 'json' }, h);
    const parsed = JSON.parse(h.stdout) as { server: string; tool: string; exposedName: string };
    expect(parsed.server).toBe('github');
    expect(parsed.tool).toBe('whoami');
    expect(parsed.exposedName).toBe('github__whoami');
  });

  it('mcp mode prints the raw CallToolResult verbatim', async () => {
    const raw: DaemonCallToolResult = {
      content: [{ type: 'text', text: 'octocat' }],
      structuredContent: { login: 'octocat' },
    };
    const h = makeHarness({ tools: [{ name: 'github__whoami', empty: true }], callResult: raw });
    const code = await run({ target: 'github__whoami' }, { output: 'mcp' }, h);
    expect(code).toBe(0);
    expect(JSON.parse(h.stdout)).toEqual(raw);
    expect(h.stderr).toBe('');
  });

  it('defaults to text mode when stdout is a TTY', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: ok('octocat'),
      isStdoutTTY: true,
    });
    await run({ target: 'github__whoami' }, {}, h);
    expect(h.stdout).toBe('octocat\n');
  });

  it('defaults to json mode when stdout is not a TTY', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: ok('octocat'),
      isStdoutTTY: false,
    });
    await run({ target: 'github__whoami' }, {}, h);
    const parsed = JSON.parse(h.stdout) as { ok: boolean; exposedName: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.exposedName).toBe('github__whoami');
  });

  it('rejects an invalid --output value as a usage error before contacting the daemon', async () => {
    const h = makeHarness();
    const code = await run({ target: 'github__whoami' }, { output: 'yaml' }, h);
    expect(code).toBe(2);
    expect(h.ensureDaemonCalls).toBe(0);
    expect(h.stderr).toMatch(/invalid --output/i);
  });
});

describe('runRun — stderr diagnostics', () => {
  it('keeps daemon startup diagnostics on stderr in json mode', async () => {
    const h = makeHarness({
      ensureDaemonFails: { code: 1, message: 'tlbx run: daemon failed to start; see the log' },
    });
    const code = await run({ target: 'github__whoami' }, { output: 'json' }, h);
    expect(code).toBe(3);
    expect(h.stderr).toContain('daemon failed to start');
    // The agent-stable failure envelope still lands on stdout.
    const parsed = JSON.parse(h.stdout) as { ok: boolean; error: { kind: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('daemon');
  });

  it('text mode writes a tool-result error to stderr, not stdout', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: { isError: true, content: [{ type: 'text', text: 'upstream said no' }] },
    });
    const code = await run({ target: 'github__whoami' }, { output: 'text' }, h);
    expect(code).toBe(1);
    expect(h.stdout).toBe('');
    expect(h.stderr).toContain('upstream said no');
  });

  it('json mode reports a tool-result error in the envelope and preserves the result', async () => {
    const errorResult: DaemonCallToolResult = {
      isError: true,
      content: [{ type: 'text', text: 'upstream said no' }],
    };
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: errorResult,
    });
    const code = await run({ target: 'github__whoami' }, { output: 'json' }, h);
    expect(code).toBe(1);
    const parsed = JSON.parse(h.stdout) as {
      ok: boolean;
      error: { kind: string; result: DaemonCallToolResult };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('tool_error');
    expect(parsed.error.result).toEqual(errorResult);
  });

  it('mcp mode prints a tool-result error raw and exits nonzero', async () => {
    const errorResult: DaemonCallToolResult = {
      isError: true,
      content: [{ type: 'text', text: 'upstream said no' }],
    };
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: errorResult,
    });
    const code = await run({ target: 'github__whoami' }, { output: 'mcp' }, h);
    expect(code).toBe(1);
    expect(JSON.parse(h.stdout)).toEqual(errorResult);
  });
});

describe('runRun — exit contract', () => {
  function mcpError(message: string, data: Record<string, unknown>): Error {
    return Object.assign(new Error(`MCP error -32603: ${message}`), { code: -32603, data });
  }

  it('exits with the usage code for invalid input', async () => {
    const h = makeHarness();
    const code = await run({ target: 'github__create_issue' }, { json: '{not json' }, h);
    expect(code).toBe(2);
  });

  it('exits with the daemon code when the connection fails', async () => {
    const h = makeHarness({ connectThrows: new Error('ECONNREFUSED') });
    const code = await run({ target: 'github__whoami' }, { json: '{}' }, h);
    expect(code).toBe(3);
    expect(h.stderr).toMatch(/failed to connect/i);
  });

  it('exits with the daemon code when listing tools fails', async () => {
    const h = makeHarness({ listToolsThrows: new Error('socket hang up') });
    const code = await run({ target: 'github__whoami' }, { json: '{}' }, h);
    expect(code).toBe(3);
    expect(h.stderr).toMatch(/failed to list tools/i);
  });

  it('exits with the unknown-tool code when the tool is not exposed', async () => {
    const h = makeHarness({ tools: [{ name: 'github__create_issue' }] });
    const code = await run({ target: 'github', tool: 'nope' }, { json: '{}' }, h);
    expect(code).toBe(4);
  });

  it('exits with the auth code when the upstream server needs authentication', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callToolThrows: mcpError('Upstream server "github" is unavailable (status: auth_required)', {
        server: 'github',
        status: { kind: 'auth_required' },
      }),
    });
    const code = await run({ target: 'github__whoami' }, {}, h);
    expect(code).toBe(5);
    expect(h.stderr).toMatch(/tlbx auth login github/);
  });

  it('exits with the auth code when the daemon returns an auth-expired result', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: {
        isError: true,
        _meta: authExpiredMeta('github'),
        content: [{ type: 'text', text: 'Authentication for "github" has expired.' }],
      },
    });
    const code = await run({ target: 'github__whoami' }, {}, h);
    expect(code).toBe(5);
    expect(h.stderr).toContain('Authentication for "github" has expired.');
  });

  it('exits with the timeout code when the upstream call times out', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callToolThrows: mcpError('Upstream tool "whoami" on server "github" timed out after 5000ms', {
        server: 'github',
        tool: 'whoami',
        code: 'timeout',
        timeoutMs: 5000,
      }),
    });
    const code = await run({ target: 'github__whoami' }, {}, h);
    expect(code).toBe(6);
  });

  it('exits with the tool-error code when the tool result is an error', async () => {
    const h = makeHarness({
      tools: [{ name: 'github__whoami', empty: true }],
      callResult: { isError: true, content: [{ type: 'text', text: 'boom' }] },
    });
    const code = await run({ target: 'github__whoami' }, {}, h);
    expect(code).toBe(1);
  });
});
