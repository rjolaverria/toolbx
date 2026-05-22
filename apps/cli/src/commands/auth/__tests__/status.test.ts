import { DEFAULT_CONFIG, type StoredOAuthRecord, type ToolBoxConfig } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeAuthHarness, makeTempConfig, type ConfigHarness } from '../../__tests__/harness.js';
import { runAuthStatus } from '../status.js';

const harnesses: ConfigHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup();
  }
});

function configWith(servers: ToolBoxConfig['servers']): ToolBoxConfig {
  return { ...DEFAULT_CONFIG, servers };
}

async function harness(config: ToolBoxConfig) {
  const cfg = await makeTempConfig(config);
  harnesses.push(cfg);
  return makeAuthHarness(cfg.target);
}

const SECRET = 'super-secret-access-token';
const record: StoredOAuthRecord = {
  schemaVersion: 1,
  clientInformation: { client_id: 'cid' },
  tokens: { access_token: SECRET, token_type: 'Bearer', refresh_token: 'super-secret-refresh' },
  authorizationServer: 'https://auth.acme.test',
  scopes: ['read', 'write'],
  obtainedAt: '2026-05-21T00:00:00.000Z',
};

describe('runAuthStatus', () => {
  it('reports no OAuth servers and exits 0 when none are configured', async () => {
    const h = await harness(
      configWith({ shell: { type: 'stdio', enabled: true, command: 'echo', args: [] } }),
    );
    const code = await runAuthStatus(undefined, {}, h.deps);
    expect(code).toBe(0);
    expect(h.stdout.value).toContain('No OAuth-configured servers');
  });

  it('lists each OAuth server with its token state', async () => {
    const h = await harness(
      configWith({
        acme: {
          type: 'http',
          enabled: true,
          url: 'https://acme.test/mcp',
          auth: { type: 'oauth' },
        },
        beta: {
          type: 'http',
          enabled: true,
          url: 'https://beta.test/mcp',
          auth: { type: 'oauth' },
        },
      }),
    );
    await h.store.write('acme', record);

    const code = await runAuthStatus(undefined, {}, h.deps);

    expect(code).toBe(0);
    const lines = h.stdout.value.split('\n');
    const acmeRow = lines.find((l) => l.startsWith('acme'));
    const betaRow = lines.find((l) => l.startsWith('beta'));
    expect(acmeRow).toContain('authenticated');
    expect(betaRow).toContain('pending');
    // Token bytes must never appear in the listing.
    expect(h.stdout.value).not.toContain(SECRET);
  });

  it('prints details for a single server without leaking token values', async () => {
    const h = await harness(
      configWith({
        acme: {
          type: 'http',
          enabled: true,
          url: 'https://acme.test/mcp',
          auth: { type: 'oauth' },
        },
      }),
    );
    await h.store.write('acme', record);

    const code = await runAuthStatus('acme', {}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('oauth');
    expect(h.stdout.value).toContain('2026-05-21T00:00:00.000Z');
    expect(h.stdout.value).toContain('https://auth.acme.test');
    expect(h.stdout.value).toContain('read, write');
    expect(h.stdout.value).not.toContain(SECRET);
    expect(h.stdout.value).not.toContain('super-secret-refresh');
  });

  it('exits 1 for an unknown server argument', async () => {
    const h = await harness(
      configWith({
        acme: {
          type: 'http',
          enabled: true,
          url: 'https://acme.test/mcp',
          auth: { type: 'oauth' },
        },
      }),
    );
    const code = await runAuthStatus('ghost', {}, h.deps);
    expect(code).toBe(1);
    expect(h.stderr.value).toContain('ghost');
  });
});
