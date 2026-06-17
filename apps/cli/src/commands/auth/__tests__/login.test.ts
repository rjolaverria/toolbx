import {
  CREDENTIAL_LOCK_DIR_ENV,
  DEFAULT_CONFIG,
  type RunOAuthLoginInput,
  type StoredOAuthRecord,
  type TokenStore,
  type TokenStoreHealth,
  type ToolBoxConfig,
} from '@toolbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeAuthHarness, makeTempConfig, type ConfigHarness } from '../../__tests__/harness.js';
import { runAuthLogin } from '../login.js';

const harnesses: ConfigHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup();
  }
  vi.unstubAllEnvs();
});

function oauthConfig(): ToolBoxConfig {
  return {
    ...DEFAULT_CONFIG,
    servers: {
      acme: { type: 'http', enabled: true, url: 'https://acme.test/mcp', auth: { type: 'oauth' } },
      shell: { type: 'stdio', enabled: true, command: 'echo', args: [] },
      plain: { type: 'http', enabled: true, url: 'https://plain.test/mcp' },
    },
  };
}

async function harness(config: ToolBoxConfig = oauthConfig()) {
  const cfg = await makeTempConfig(config);
  harnesses.push(cfg);
  // Root the credential lock under the temp dir so login's lock acquisition
  // never touches the real per-user lock location.
  vi.stubEnv(CREDENTIAL_LOCK_DIR_ENV, cfg.dir);
  return makeAuthHarness(cfg.target);
}

const sampleRecord: StoredOAuthRecord = {
  schemaVersion: 2,
  clientInformation: { client_id: 'cid' },
  tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' },
  authorizationServer: 'https://acme.test',
  scopes: [],
  obtainedAt: '2026-05-21T00:00:00.000Z',
};

describe('runAuthLogin', () => {
  it('exits 1 when the server is not configured', async () => {
    const h = await harness();
    const code = await runAuthLogin('ghost', {}, h.deps);
    expect(code).toBe(1);
    expect(h.stderr.value).toContain('not configured');
  });

  it('exits 1 when the server is not configured for OAuth', async () => {
    const h = await harness();
    const code = await runAuthLogin('plain', {}, h.deps);
    expect(code).toBe(1);
    expect(h.stderr.value).toContain('not configured for OAuth');
    expect(h.stderr.value).toContain('"none"');
  });

  it('forces a re-auth handshake and exits 0 on success, writing the token', async () => {
    const h = await harness();
    h.deps.runOAuthLogin = vi.fn(async (input: RunOAuthLoginInput) => {
      await input.tokenStore.write(input.serverName, sampleRecord);
      return { kind: 'success' as const };
    });

    const code = await runAuthLogin('acme', {}, h.deps);

    expect(code).toBe(0);
    expect(h.deps.runOAuthLogin).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'acme', forceReauth: true }),
    );
    expect(h.stdout.value).toContain('✓ acme authenticated');
    expect(await h.store.read('acme')).toEqual(sampleRecord);
  });

  it('threads the probed resource-metadata URL into the login flow', async () => {
    const h = await harness();
    const metaUrl = new URL('https://acme.test/.well-known/oauth-protected-resource/mcp');
    h.deps.probeAuth = vi.fn(() =>
      Promise.resolve({ kind: 'oauth' as const, resourceMetadataUrl: metaUrl }),
    );
    h.deps.runOAuthLogin = vi.fn(() => Promise.resolve({ kind: 'success' as const }));

    const code = await runAuthLogin('acme', {}, h.deps);

    expect(code).toBe(0);
    expect(h.deps.probeAuth).toHaveBeenCalledWith(new URL('https://acme.test/mcp'));
    expect(h.deps.runOAuthLogin).toHaveBeenCalledWith(
      expect.objectContaining({ resourceMetadataUrl: metaUrl }),
    );
  });

  it('logs in without a resource-metadata URL when the probe does not surface one', async () => {
    const h = await harness();
    h.deps.probeAuth = vi.fn(() => Promise.resolve({ kind: 'unknown' as const, status: 0 }));
    h.deps.runOAuthLogin = vi.fn((input: RunOAuthLoginInput) => {
      expect(input.resourceMetadataUrl).toBeUndefined();
      return Promise.resolve({ kind: 'success' as const });
    });

    const code = await runAuthLogin('acme', {}, h.deps);

    expect(code).toBe(0);
    expect(h.deps.runOAuthLogin).toHaveBeenCalledTimes(1);
  });

  it('exits 2 and writes no token when the flow is cancelled', async () => {
    const h = await harness();
    h.deps.runOAuthLogin = vi.fn(() =>
      Promise.resolve({ kind: 'cancelled' as const, reason: 'aborted by caller' }),
    );

    const code = await runAuthLogin('acme', {}, h.deps);

    expect(code).toBe(2);
    expect(h.stderr.value).toContain('aborted by caller');
    expect(await h.store.read('acme')).toBeNull();
  });

  it('exits 4 and writes no token when the flow fails', async () => {
    const h = await harness();
    h.deps.runOAuthLogin = vi.fn(() =>
      Promise.resolve({ kind: 'failed' as const, reason: 'discovery exploded' }),
    );

    const code = await runAuthLogin('acme', {}, h.deps);

    expect(code).toBe(4);
    expect(h.stderr.value).toContain('discovery exploded');
    expect(await h.store.read('acme')).toBeNull();
  });

  it('exits 3 when the token store is unavailable, without starting the flow', async () => {
    const h = await harness();
    const unavailable: TokenStore = {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      probe: (): Promise<TokenStoreHealth> =>
        Promise.resolve({ kind: 'unavailable', reason: 'keychain locked' }),
    };
    h.deps.createTokenStore = () => unavailable;
    h.deps.runOAuthLogin = vi.fn(() => Promise.resolve({ kind: 'success' as const }));

    const code = await runAuthLogin('acme', {}, h.deps);

    expect(code).toBe(3);
    expect(h.stderr.value).toContain('keychain locked');
    expect(h.deps.runOAuthLogin).not.toHaveBeenCalled();
  });
});
