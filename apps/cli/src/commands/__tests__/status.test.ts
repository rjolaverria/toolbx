import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type ServerConfig, type ToolBoxConfig } from '@rjolaverria/toolbox-core';

import { probeServer, type ProbeResult } from '../server-probe.js';
import { runStatus, type StatusDeps } from '../status.js';

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
  probeCalls: string[];
}

function makeHarness(target: string, results: Record<string, ProbeResult>): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const probeCalls: string[] = [];
  const deps: StatusDeps = {
    resolvePath: () => target,
    cwd: () => path.dirname(target),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    probe: (name) => {
      probeCalls.push(name);
      const result = results[name];
      if (result === undefined) {
        throw new Error(`no probe result configured for ${name}`);
      }
      return Promise.resolve(result);
    },
  };
  return { deps, stdout, stderr, probeCalls };
}

function makeRealProbeHarness(target: string): {
  deps: StatusDeps;
  stdout: { value: string };
  stderr: { value: string };
} {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const deps: StatusDeps = {
    resolvePath: () => target,
    cwd: () => path.dirname(target),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    probe: probeServer,
  };
  return { deps, stdout, stderr };
}

function configWith(servers: Record<string, ServerConfig>): ToolBoxConfig {
  return { ...DEFAULT_CONFIG, servers };
}

describe('runStatus', () => {
  it('shows connected and a tool count for a healthy server', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const connectedAt = new Date('2026-04-30T12:00:00.000Z');
    const h = makeHarness(cfg.target, {
      github: {
        kind: 'connected',
        tools: [
          { name: 'a', inputSchema: { type: 'object' } },
          { name: 'b', inputSchema: { type: 'object' } },
        ],
        connectedAt,
      },
    });

    const code = await runStatus({}, h.deps);

    expect(code).toBe(0);
    expect(h.probeCalls).toEqual(['github']);
    const lines = h.stdout.value.trimEnd().split('\n');
    expect(lines[0]).toContain('NAME');
    expect(lines[0]).toContain('STATUS');
    expect(lines[0]).toContain('TOOLS');
    expect(lines[1]).toContain('github');
    expect(lines[1]).toContain('connected');
    expect(lines[1]).toContain('2');
    expect(lines[1]).toContain(connectedAt.toISOString());
  });

  it('exits non-zero and surfaces the upstream error message for a broken server', async () => {
    const cfg = await makeTempConfig(
      configWith({
        broken: {
          type: 'stdio',
          enabled: true,
          command: '/this/binary/does/not/exist',
          args: [],
          timeoutMs: 2000,
        },
      }),
    );
    harnesses.push(cfg);
    const h = makeRealProbeHarness(cfg.target);

    const code = await runStatus({ timeout: 2000 }, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('error');
    expect(h.stdout.value).toMatch(/this\/binary\/does\/not\/exist|ENOENT/);
  });

  it('--no-connect reports enabled/disabled without invoking the probe', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
        archived: { type: 'stdio', enabled: false, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {});

    const code = await runStatus({ connect: false }, h.deps);

    expect(code).toBe(0);
    expect(h.probeCalls).toHaveLength(0);
    expect(h.stdout.value).toContain('archived');
    expect(h.stdout.value).toContain('disabled');
    expect(h.stdout.value).toContain('github');
    expect(h.stdout.value).toContain('enabled');
  });

  it('--server filters to a single named server', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
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
      github: {
        kind: 'connected',
        tools: [{ name: 't', inputSchema: { type: 'object' } }],
        connectedAt: new Date('2026-04-30T12:00:00.000Z'),
      },
    });

    const code = await runStatus({ server: 'github' }, h.deps);

    expect(code).toBe(0);
    expect(h.probeCalls).toEqual(['github']);
    expect(h.stdout.value).toContain('github');
    expect(h.stdout.value).not.toContain('linear');
  });

  it('--server with an unknown name exits 1', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {});

    const code = await runStatus({ server: 'does-not-exist' }, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Unknown server "does-not-exist"');
    expect(h.probeCalls).toHaveLength(0);
  });

  it('exits 1 when an enabled server reports auth_required', async () => {
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
      linear: { kind: 'auth_required', reason: 'Bearer token "LINEAR_TOKEN" is not set.' },
    });

    const code = await runStatus({}, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('auth_required');
    expect(h.stdout.value).toContain('LINEAR_TOKEN');
  });

  it('disabled enabled-server-only error rule: an error on a disabled server does not fail', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: false, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      github: { kind: 'disabled' },
    });

    const code = await runStatus({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('disabled');
  });

  it('--json emits a stable, snapshot-tested shape', async () => {
    const cfg = await makeTempConfig(
      configWith({
        archived: { type: 'stdio', enabled: false, command: 'true', args: [] },
        broken: { type: 'stdio', enabled: true, command: 'true', args: [] },
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
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
      archived: { kind: 'disabled' },
      broken: { kind: 'error', error: new Error('connection refused') },
      github: {
        kind: 'connected',
        tools: [
          { name: 'a', inputSchema: { type: 'object' } },
          { name: 'b', inputSchema: { type: 'object' } },
        ],
        connectedAt,
      },
      linear: { kind: 'auth_required', reason: 'Bearer token "LINEAR_TOKEN" is not set.' },
    });

    const code = await runStatus({ json: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toMatchSnapshot();
    const parsed = JSON.parse(h.stdout.value) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('exits 1 with a clear message when the config is missing', async () => {
    const h = makeHarness('/nonexistent/toolbox/config.json', {});

    const code = await runStatus({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('No ToolBox config found');
  });

  it('renders an empty-config message when no servers are configured', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {});

    const code = await runStatus({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('No servers configured.');
  });
});
