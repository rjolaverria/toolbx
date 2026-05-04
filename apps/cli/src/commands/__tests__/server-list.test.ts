import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type ToolBoxConfig } from '@toolbox/core';

import { runServerList } from '../server-list.js';

import { makeHarness, makeTempConfig, type ConfigHarness } from './harness.js';

const harnesses: ConfigHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) {
      await h.cleanup();
    }
  }
});

function withServers(
  servers: ToolBoxConfig['servers'],
  base: ToolBoxConfig = DEFAULT_CONFIG,
): ToolBoxConfig {
  return { ...base, servers };
}

describe('runServerList', () => {
  it('reports no servers configured for an empty config', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runServerList({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('No servers configured.');
    expect(h.stderr.value).toBe('');
  });

  it('renders a stable table sorted by name', async () => {
    const cfg = await makeTempConfig(
      withServers({
        zed: {
          type: 'stdio',
          enabled: true,
          command: 'npx',
          args: ['-y', 'zed-server'],
        },
        alpha: {
          type: 'http',
          enabled: false,
          url: 'https://example.com/mcp',
          timeoutMs: 5000,
        },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runServerList({}, h.deps);

    expect(code).toBe(0);
    const lines = h.stdout.value.trimEnd().split('\n');
    expect(lines[0]).toContain('NAME');
    expect(lines[0]).toContain('TYPE');
    expect(lines[0]).toContain('TARGET');
    expect(lines[1]?.startsWith('alpha')).toBe(true);
    expect(lines[2]?.startsWith('zed')).toBe(true);
    expect(lines[1]).toContain('http');
    expect(lines[1]).toContain('5000ms');
    expect(lines[2]).toContain('npx -y zed-server');
  });

  it('--json emits a stable schema with transport-specific fields', async () => {
    const cfg = await makeTempConfig(
      withServers({
        github: {
          type: 'stdio',
          enabled: true,
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          timeoutMs: 60000,
        },
        linear: {
          type: 'http',
          enabled: true,
          url: 'https://mcp.linear.app/sse',
        },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runServerList({ json: true }, h.deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.value) as unknown;
    expect(parsed).toEqual([
      {
        name: 'github',
        type: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        timeoutMs: 60000,
      },
      {
        name: 'linear',
        type: 'http',
        enabled: true,
        url: 'https://mcp.linear.app/sse',
        timeoutMs: null,
      },
    ]);
  });

  it('exits 1 with a clear message when the config is missing', async () => {
    const h = makeHarness('/nonexistent/toolbox/config.json');

    const code = await runServerList({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('No ToolBox config found');
  });
});
