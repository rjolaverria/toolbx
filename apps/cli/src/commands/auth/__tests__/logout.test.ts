import { DEFAULT_CONFIG, type StoredOAuthRecord, type ToolBoxConfig } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeAuthHarness, makeTempConfig, type ConfigHarness } from '../../__tests__/harness.js';
import { runAuthLogout } from '../logout.js';

const harnesses: ConfigHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup();
  }
});

function oauthConfig(): ToolBoxConfig {
  return {
    ...DEFAULT_CONFIG,
    servers: {
      acme: { type: 'http', enabled: true, url: 'https://acme.test/mcp', auth: { type: 'oauth' } },
    },
  };
}

async function harness() {
  const cfg = await makeTempConfig(oauthConfig());
  harnesses.push(cfg);
  return makeAuthHarness(cfg.target);
}

const record: StoredOAuthRecord = {
  schemaVersion: 1,
  clientInformation: { client_id: 'cid' },
  tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' },
  authorizationServer: 'https://acme.test',
  scopes: [],
  obtainedAt: '2026-05-21T00:00:00.000Z',
};

describe('runAuthLogout', () => {
  it('reports a no-op and exits 0 when no token is stored', async () => {
    const h = await harness();
    const code = await runAuthLogout('acme', {}, h.deps);
    expect(code).toBe(0);
    expect(h.stdout.value).toContain('no token was stored');
  });

  it('deletes the stored token and exits 0', async () => {
    const h = await harness();
    await h.store.write('acme', record);

    const code = await runAuthLogout('acme', {}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('✓ acme logged out');
    expect(await h.store.read('acme')).toBeNull();
  });
});
