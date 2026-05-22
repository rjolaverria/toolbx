import {
  DEFAULT_CONFIG,
  type RunOAuthRefreshInput,
  type StoredOAuthRecord,
  type ToolBoxConfig,
} from '@toolbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeAuthHarness, makeTempConfig, type ConfigHarness } from '../../__tests__/harness.js';
import { runAuthRefresh } from '../refresh.js';

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

function record(obtainedAt: string, accessToken = 'a'): StoredOAuthRecord {
  return {
    schemaVersion: 1,
    clientInformation: { client_id: 'cid' },
    tokens: { access_token: accessToken, token_type: 'Bearer', refresh_token: 'r' },
    authorizationServer: 'https://acme.test',
    scopes: [],
    obtainedAt,
  };
}

describe('runAuthRefresh', () => {
  it('exits 1 when no token is stored', async () => {
    const h = await harness();
    const code = await runAuthRefresh('acme', {}, h.deps);
    expect(code).toBe(1);
    expect(h.stderr.value).toContain('No stored token for acme');
  });

  it('refreshes the token and exits 0', async () => {
    const h = await harness();
    await h.store.write('acme', record('2020-01-01T00:00:00.000Z'));
    h.deps.runOAuthRefresh = vi.fn(async (input: RunOAuthRefreshInput) => {
      await input.tokenStore.write(
        input.serverName,
        record('2026-05-21T12:00:00.000Z', 'refreshed'),
      );
      return { kind: 'success' as const };
    });

    const code = await runAuthRefresh('acme', {}, h.deps);

    expect(code).toBe(0);
    expect(h.deps.runOAuthRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'acme' }),
    );
    expect(h.stdout.value).toContain('✓ acme token refreshed');
    const stored = await h.store.read('acme');
    expect(stored?.obtainedAt).toBe('2026-05-21T12:00:00.000Z');
    expect(stored?.tokens.access_token).toBe('refreshed');
  });

  it('threads the probed resource-metadata URL into the refresh flow', async () => {
    const h = await harness();
    await h.store.write('acme', record('2020-01-01T00:00:00.000Z'));
    const metaUrl = new URL('https://acme.test/.well-known/oauth-protected-resource/mcp');
    h.deps.probeAuth = vi.fn(() =>
      Promise.resolve({ kind: 'oauth' as const, resourceMetadataUrl: metaUrl }),
    );
    h.deps.runOAuthRefresh = vi.fn(() => Promise.resolve({ kind: 'success' as const }));

    const code = await runAuthRefresh('acme', {}, h.deps);

    expect(code).toBe(0);
    expect(h.deps.runOAuthRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ resourceMetadataUrl: metaUrl }),
    );
  });

  it('exits 4 when the refresh fails', async () => {
    const h = await harness();
    await h.store.write('acme', record('2020-01-01T00:00:00.000Z'));
    h.deps.runOAuthRefresh = vi.fn(() =>
      Promise.resolve({ kind: 'failed' as const, reason: 'refresh token expired' }),
    );

    const code = await runAuthRefresh('acme', {}, h.deps);

    expect(code).toBe(4);
    expect(h.stderr.value).toContain('refresh token expired');
  });
});
