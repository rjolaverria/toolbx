import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type ToolboxConfig } from '@toolbox/core';

import { runServerStatus, type StatusDeps } from '../server-status.js';
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
  deps: StatusDeps;
  stdout: { value: string };
  stderr: { value: string };
  probeCalls: Array<{ name: string }>;
}

function makeHarness(target: string, result: ProbeResult): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const probeCalls: Array<{ name: string }> = [];
  const deps: StatusDeps = {
    resolvePath: () => target,
    cwd: () => path.dirname(target),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    probe: async (name) => {
      probeCalls.push({ name });
      return Promise.resolve(result);
    },
  };
  return { deps, stdout, stderr, probeCalls };
}

function configWith(servers: ToolboxConfig['servers']): ToolboxConfig {
  return { ...DEFAULT_CONFIG, servers };
}

describe('runServerStatus', () => {
  it('prints connected state and tool count for a healthy server', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const connectedAt = new Date('2026-04-30T12:00:00.000Z');
    const h = makeHarness(cfg.target, {
      kind: 'connected',
      tools: [
        { name: 'a', inputSchema: { type: 'object' } },
        { name: 'b', inputSchema: { type: 'object' } },
      ],
      connectedAt,
    });

    const code = await runServerStatus('github', {}, h.deps);

    expect(code).toBe(0);
    expect(h.probeCalls).toEqual([{ name: 'github' }]);
    expect(h.stdout.value).toContain('status: connected');
    expect(h.stdout.value).toContain('tools: 2');
    expect(h.stdout.value).toContain(connectedAt.toISOString());
  });

  it('emits a stable JSON shape when --json is set', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const connectedAt = new Date('2026-04-30T12:00:00.000Z');
    const h = makeHarness(cfg.target, {
      kind: 'connected',
      tools: [{ name: 'tool', inputSchema: { type: 'object' } }],
      connectedAt,
    });

    const code = await runServerStatus('github', { json: true }, h.deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.value) as unknown;
    expect(parsed).toEqual({
      name: 'github',
      type: 'stdio',
      enabled: true,
      status: 'connected',
      toolCount: 1,
      connectedAt: connectedAt.toISOString(),
      authRequired: null,
      error: null,
    });
  });

  it('reports auth_required and exits zero', async () => {
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
    const h = makeHarness(cfg.target, {
      kind: 'auth_required',
      reason: 'Bearer token "LINEAR_TOKEN" is not set.',
    });

    const code = await runServerStatus('linear', {}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('status: auth_required');
    expect(h.stdout.value).toContain('LINEAR_TOKEN');
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
      error: new Error('connection refused'),
    });

    const code = await runServerStatus('github', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('status: error');
    expect(h.stdout.value).toContain('connection refused');
  });

  it('skips the probe for disabled servers', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: false, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { kind: 'disabled' });

    const code = await runServerStatus('github', {}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('status: disabled');
    expect(h.probeCalls).toHaveLength(1);
  });

  it('rejects an unknown server', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { kind: 'disabled' });

    const code = await runServerStatus('does-not-exist', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Unknown server');
    expect(h.probeCalls).toHaveLength(0);
  });
});
