import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type ToolBoxConfig } from '@toolbox/core';

import {
  runClientPrintConfig,
  SUPPORTED_CLIENTS,
  type ClientId,
  type Transport,
} from '../client-print-config.js';

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

function withHttp(
  http: Partial<ToolBoxConfig['server']['http']>,
  base: ToolBoxConfig = DEFAULT_CONFIG,
): ToolBoxConfig {
  return {
    ...base,
    server: {
      ...base.server,
      http: { ...base.server.http, ...http },
    },
  };
}

const CLIENT_X_TRANSPORT: ReadonlyArray<[ClientId, Transport]> = [
  ['claude', 'stdio'],
  ['claude', 'http'],
  ['codex', 'stdio'],
  ['codex', 'http'],
  ['opencode', 'stdio'],
  ['opencode', 'http'],
  ['generic', 'stdio'],
  ['generic', 'http'],
];

describe('runClientPrintConfig', () => {
  it('lists all four supported clients', () => {
    expect([...SUPPORTED_CLIENTS]).toEqual(['claude', 'codex', 'opencode', 'generic']);
  });

  it('rejects an unknown client with a non-zero exit and the supported list', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runClientPrintConfig('cursor', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Unknown client "cursor"');
    expect(h.stderr.value).toContain('claude, codex, opencode, generic');
    expect(h.stdout.value).toBe('');
  });

  it('rejects --stdio + --http with exit code 2', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runClientPrintConfig('claude', { stdio: true, http: true }, h.deps);

    expect(code).toBe(2);
    expect(h.stderr.value).toContain('mutually exclusive');
  });

  it('exits 1 when --http is requested but the config is missing', async () => {
    const h = makeHarness('/nonexistent/toolbox/config.json');

    const code = await runClientPrintConfig('claude', { http: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('No ToolBox config found');
  });

  it('claude stdio default snippet matches SPECS §4.3 exactly', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runClientPrintConfig('claude', { json: true }, h.deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.value) as unknown;
    expect(parsed).toEqual({
      mcpServers: {
        toolbox: {
          command: 'npx',
          args: ['-y', 'tlbx', 'serve', '--stdio'],
        },
      },
    });
  });

  it.each(CLIENT_X_TRANSPORT)(
    '--json output for %s/%s parses cleanly and matches snapshot',
    async (client, transport) => {
      const cfg = await makeTempConfig(withHttp({ host: '127.0.0.1', port: 7331, path: '/mcp' }));
      harnesses.push(cfg);
      const h = makeHarness(cfg.target);

      const options =
        transport === 'http'
          ? { http: true as const, json: true as const }
          : { json: true as const };
      const code = await runClientPrintConfig(client, options, h.deps);

      expect(code).toBe(0);
      expect(h.stderr.value).toBe('');
      expect(() => {
        JSON.parse(h.stdout.value);
      }).not.toThrow();
      expect(h.stdout.value).toMatchSnapshot();
    },
  );

  it.each(CLIENT_X_TRANSPORT)(
    'default friendly output for %s/%s contains an explanation and a fenced code block',
    async (client, transport) => {
      const cfg = await makeTempConfig(withHttp({ host: '127.0.0.1', port: 7331, path: '/mcp' }));
      harnesses.push(cfg);
      const h = makeHarness(cfg.target);

      const options = transport === 'http' ? { http: true as const } : {};
      const code = await runClientPrintConfig(client, options, h.deps);

      expect(code).toBe(0);
      expect(h.stderr.value).toBe('');
      const fenceLanguage = client === 'codex' ? '```toml' : '```json';
      expect(h.stdout.value).toContain(fenceLanguage);
      expect(h.stdout.value).toContain('```\n');
      if (client !== 'codex') {
        // The fenced JSON must still parse on its own.
        const fenceStart = h.stdout.value.indexOf('```json\n') + '```json\n'.length;
        const fenceEnd = h.stdout.value.indexOf('\n```', fenceStart);
        const fenced = h.stdout.value.slice(fenceStart, fenceEnd);
        expect(() => {
          JSON.parse(fenced);
        }).not.toThrow();
      }
      expect(h.stdout.value).toMatchSnapshot();
    },
  );

  it('codex stdio friendly output emits Codex CLI native TOML config.toml shape', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runClientPrintConfig('codex', {}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('~/.codex/config.toml');
    expect(h.stdout.value).toContain('```toml');
    expect(h.stdout.value).toContain('[mcp_servers.toolbox]');
    expect(h.stdout.value).toContain('command = "npx"');
    expect(h.stdout.value).toContain('args = ["-y", "tlbx", "serve", "--stdio"]');
  });

  it('codex http friendly output emits the configured URL inside the TOML table', async () => {
    const cfg = await makeTempConfig(withHttp({ host: 'localhost', port: 9000, path: '/gateway' }));
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runClientPrintConfig('codex', { http: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('```toml');
    expect(h.stdout.value).toContain('[mcp_servers.toolbox]');
    expect(h.stdout.value).toContain('url = "http://localhost:9000/gateway"');
  });

  it('exits 1 when --http is requested but server.http.enabled is false in config', async () => {
    const cfg = await makeTempConfig(withHttp({ enabled: false }));
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runClientPrintConfig('claude', { http: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('server.http.enabled is false');
    expect(h.stdout.value).toBe('');
  });

  it('http snippets reference the configured host, port, and path (not defaults)', async () => {
    const cfg = await makeTempConfig(withHttp({ host: 'localhost', port: 9000, path: '/gateway' }));
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runClientPrintConfig('claude', { http: true, json: true }, h.deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.value) as { mcpServers: { toolbox: { url: string } } };
    expect(parsed.mcpServers.toolbox.url).toBe('http://localhost:9000/gateway');
  });

  it('http snippets bracket IPv6 loopback hosts in the URL', async () => {
    const cfg = await makeTempConfig(withHttp({ host: '::1', port: 7331, path: '/mcp' }));
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runClientPrintConfig('generic', { http: true, json: true }, h.deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.value) as { mcpServers: { toolbox: { url: string } } };
    expect(parsed.mcpServers.toolbox.url).toBe('http://[::1]:7331/mcp');
  });

  it('does not require a config file for stdio snippets', async () => {
    const h = makeHarness('/nonexistent/toolbox/config.json');

    const code = await runClientPrintConfig('claude', { stdio: true, json: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stderr.value).toBe('');
    const parsed = JSON.parse(h.stdout.value) as unknown;
    expect(parsed).toEqual({
      mcpServers: {
        toolbox: {
          command: 'npx',
          args: ['-y', 'tlbx', 'serve', '--stdio'],
        },
      },
    });
  });
});
