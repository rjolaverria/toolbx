import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type ToolBoxConfig } from '@rjolaverria/toolbox-core';

import { runServerInspect, type InspectDeps } from '../server-inspect.js';
import type { ProbeResult } from '../server-probe.js';

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
  deps: InspectDeps;
  stdout: { value: string };
  stderr: { value: string };
}

function makeHarness(target: string, result: ProbeResult): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const deps: InspectDeps = {
    resolvePath: () => target,
    cwd: () => path.dirname(target),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    probe: async () => Promise.resolve(result),
  };
  return { deps, stdout, stderr };
}

function configWith(servers: ToolBoxConfig['servers']): ToolBoxConfig {
  return { ...DEFAULT_CONFIG, servers };
}

describe('runServerInspect', () => {
  it('prints config, auth metadata, and the discovered tool list', async () => {
    const cfg = await makeTempConfig(
      configWith({
        linear: {
          type: 'http',
          enabled: true,
          url: 'https://example.com/mcp',
          auth: { type: 'bearer', tokenEnv: 'LINEAR_TOKEN' },
        },
      }),
    );
    harnesses.push(cfg);
    const connectedAt = new Date('2026-04-30T12:00:00.000Z');
    const h = makeHarness(cfg.target, {
      kind: 'connected',
      tools: [
        { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object' } },
        { name: 'list_issues', inputSchema: { type: 'object' } },
      ],
      connectedAt,
    });

    const code = await runServerInspect('linear', {}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('transport: http');
    expect(h.stdout.value).toContain('auth: bearer');
    expect(h.stdout.value).toContain('LINEAR_TOKEN');
    expect(h.stdout.value).toContain('tools (2):');
    expect(h.stdout.value).toContain('create_issue: Create an issue');
    expect(h.stdout.value).toContain('list_issues');
  });

  it('--json includes config, status, auth, and tools', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: ['-x'] },
      }),
    );
    harnesses.push(cfg);
    const connectedAt = new Date('2026-04-30T12:00:00.000Z');
    const h = makeHarness(cfg.target, {
      kind: 'connected',
      tools: [{ name: 'a', inputSchema: { type: 'object' } }],
      connectedAt,
    });

    const code = await runServerInspect('github', { json: true }, h.deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.value) as {
      name: string;
      transport: string;
      auth: { type: string };
      status: { kind: string; toolCount: number };
      tools: Array<{ name: string }>;
    };
    expect(parsed.name).toBe('github');
    expect(parsed.transport).toBe('stdio');
    expect(parsed.auth).toEqual({ type: 'none' });
    expect(parsed.status.kind).toBe('connected');
    expect(parsed.status.toolCount).toBe(1);
    expect(parsed.tools).toEqual([{ name: 'a', description: null }]);
  });

  it('omits tools and reports disabled state for disabled servers', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: false, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { kind: 'disabled' });

    const code = await runServerInspect('github', { json: true }, h.deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.value) as { tools: unknown; status: { kind: string } };
    expect(parsed.tools).toBeNull();
    expect(parsed.status.kind).toBe('disabled');
  });

  it('exits 1 when the probe reports an error', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      kind: 'error',
      error: new Error('boom'),
    });

    const code = await runServerInspect('github', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('status: error');
  });

  it('rejects an unknown server', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { kind: 'disabled' });

    const code = await runServerInspect('does-not-exist', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Unknown server');
  });
});
