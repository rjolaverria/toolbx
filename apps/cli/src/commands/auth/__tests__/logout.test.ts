import {
  DEFAULT_CONFIG,
  type StoredOAuthRecord,
  type TokenStore,
  type ToolBoxConfig,
} from '@toolbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('still deletes a corrupt entry whose read throws', async () => {
    const cfg = await makeTempConfig(oauthConfig());
    harnesses.push(cfg);
    const h = makeAuthHarness(cfg.target);
    const del = vi.fn(() => Promise.resolve());
    const corrupt: TokenStore = {
      // A corrupt or schema-incompatible record throws on read; logout must
      // still clear it.
      read: () => Promise.reject(new Error('corrupt record')),
      write: () => Promise.resolve(),
      delete: del,
      list: () => Promise.resolve([]),
      probe: () => Promise.resolve({ kind: 'ready' }),
    };
    h.deps.createTokenStore = () => corrupt;

    const code = await runAuthLogout('acme', {}, h.deps);

    expect(code).toBe(0);
    expect(del).toHaveBeenCalledWith('acme');
    expect(h.stdout.value).toContain('✓ acme logged out');
  });

  it('exits 1 when deleting the token fails', async () => {
    const cfg = await makeTempConfig(oauthConfig());
    harnesses.push(cfg);
    const h = makeAuthHarness(cfg.target);
    const failing: TokenStore = {
      read: () => Promise.resolve(record),
      write: () => Promise.resolve(),
      delete: () => Promise.reject(new Error('keychain is locked')),
      list: () => Promise.resolve([]),
      probe: () => Promise.resolve({ kind: 'ready' }),
    };
    h.deps.createTokenStore = () => failing;

    const code = await runAuthLogout('acme', {}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('keychain is locked');
  });
});
