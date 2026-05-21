import type { OAuthClientInformation, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { describe, expect, it } from 'vitest';

import { createNoopLogger } from '../../logging/logger.js';
import {
  SuppressedRedirectError,
  ToolBoxOAuthProvider,
  type ToolBoxOAuthProviderOpts,
} from '../oauth-provider.js';
import { InMemoryTokenStore, type StoredOAuthRecord, type TokenStore } from '../token-store.js';

function makeClientInfo(overrides: Partial<OAuthClientInformation> = {}): OAuthClientInformation {
  return { client_id: 'client-abc', ...overrides };
}

function makeTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return { access_token: 'access-1', token_type: 'Bearer', ...overrides };
}

function makeRecord(overrides: Partial<StoredOAuthRecord> = {}): StoredOAuthRecord {
  return {
    schemaVersion: 1,
    clientInformation: makeClientInfo(),
    tokens: makeTokens(),
    authorizationServer: 'https://auth.example.com',
    scopes: ['read'],
    obtainedAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ToolBoxOAuthProviderOpts> = {}): {
  provider: ToolBoxOAuthProvider;
  store: InMemoryTokenStore;
} {
  const store =
    overrides.tokenStore instanceof InMemoryTokenStore
      ? overrides.tokenStore
      : new InMemoryTokenStore();
  const provider = new ToolBoxOAuthProvider({
    serverName: 'jira',
    redirectUrl: new URL('http://127.0.0.1:8976/callback'),
    tokenStore: store,
    logger: createNoopLogger(),
    ...overrides,
  });
  return { provider, store };
}

describe('ToolBoxOAuthProvider.clientMetadata', () => {
  it('builds public-client metadata with the configured redirect and name', () => {
    const { provider } = makeProvider({
      serverName: 'jira',
      redirectUrl: new URL('http://127.0.0.1:8976/callback'),
    });
    const meta = provider.clientMetadata;
    expect(meta.client_name).toBe('ToolBox (jira)');
    expect(meta.redirect_uris).toEqual(['http://127.0.0.1:8976/callback']);
    expect(meta.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(meta.response_types).toEqual(['code']);
    expect(meta.token_endpoint_auth_method).toBe('none');
    expect(meta.scope).toBeUndefined();
  });

  it('uses a custom client name and joins scopes when configured', () => {
    const { provider } = makeProvider({
      clientName: 'My ToolBox',
      scopes: ['read', 'write'],
    });
    const meta = provider.clientMetadata;
    expect(meta.client_name).toBe('My ToolBox');
    expect(meta.scope).toBe('read write');
  });

  it('omits scope entirely when scopes is an empty array', () => {
    // An empty `scope` string is rejected as malformed by many OAuth servers,
    // so callers that normalize "no scopes" to [] must produce no scope field.
    const { provider } = makeProvider({ scopes: [] });
    expect(provider.clientMetadata.scope).toBeUndefined();
    expect('scope' in provider.clientMetadata).toBe(false);
  });
});

describe('ToolBoxOAuthProvider.redirectUrl', () => {
  it('returns the configured redirect URL', () => {
    const url = new URL('http://127.0.0.1:9999/cb');
    const { provider } = makeProvider({ redirectUrl: url });
    expect(provider.redirectUrl.toString()).toBe(url.toString());
  });
});

describe('ToolBoxOAuthProvider.clientInformation', () => {
  it('returns undefined for an unknown server', async () => {
    const { provider } = makeProvider();
    expect(await provider.clientInformation()).toBeUndefined();
  });

  it('returns staged info after saveClientInformation, before saveTokens', async () => {
    const { provider } = makeProvider();
    const info = makeClientInfo({ client_id: 'staged-1' });
    await provider.saveClientInformation(info);
    expect(await provider.clientInformation()).toEqual(info);
  });

  it('returns the stored record clientInformation when present', async () => {
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({ clientInformation: makeClientInfo({ client_id: 'stored-1' }) }),
    );
    expect(await provider.clientInformation()).toEqual(makeClientInfo({ client_id: 'stored-1' }));
  });
});

describe('ToolBoxOAuthProvider.saveClientInformation (atomicity)', () => {
  it('does not touch the TokenStore', async () => {
    const { provider, store } = makeProvider();
    await provider.saveClientInformation(makeClientInfo());
    expect(await store.read('jira')).toBeNull();
  });
});

describe('ToolBoxOAuthProvider.saveTokens', () => {
  it('writes a complete record with staged client info and clears the staged copy', async () => {
    const { provider, store } = makeProvider({ scopes: ['read'] });
    await provider.saveClientInformation(makeClientInfo({ client_id: 'staged-1' }));
    provider.setAuthorizationServer('https://auth.example.com');
    const tokens = makeTokens({ access_token: 'new-access' });
    await provider.saveTokens(tokens);

    const record = await store.read('jira');
    expect(record).not.toBeNull();
    expect(record?.clientInformation).toEqual(makeClientInfo({ client_id: 'staged-1' }));
    expect(record?.tokens).toEqual(tokens);
    expect(record?.authorizationServer).toBe('https://auth.example.com');
    expect(record?.scopes).toEqual(['read']);

    // Staged copy cleared: a second saveTokens with no new client info must
    // reuse the now-persisted record rather than the in-memory staged copy.
    await provider.saveTokens(makeTokens({ access_token: 'second-access' }));
    expect((await store.read('jira'))?.clientInformation).toEqual(
      makeClientInfo({ client_id: 'staged-1' }),
    );
  });

  it('throws when no client information has been saved and no record exists', async () => {
    const { provider } = makeProvider();
    await expect(provider.saveTokens(makeTokens())).rejects.toThrow(/clientInformation/);
  });

  it('throws without an authorization server URL', async () => {
    const { provider } = makeProvider();
    await provider.saveClientInformation(makeClientInfo());
    await expect(provider.saveTokens(makeTokens())).rejects.toThrow(
      /without an authorization server URL/,
    );
  });

  it('persists the authorization server set via setAuthorizationServer', async () => {
    const { provider, store } = makeProvider();
    await provider.saveClientInformation(makeClientInfo());
    provider.setAuthorizationServer('https://issuer.example.com');
    await provider.saveTokens(makeTokens());
    expect((await store.read('jira'))?.authorizationServer).toBe('https://issuer.example.com');
  });

  it('uses opts.authorizationServer as a fallback', async () => {
    const { provider, store } = makeProvider({ authorizationServer: 'https://opts.example.com' });
    await provider.saveClientInformation(makeClientInfo());
    await provider.saveTokens(makeTokens());
    expect((await store.read('jira'))?.authorizationServer).toBe('https://opts.example.com');
  });

  it('reuses an existing record for re-auth without saveClientInformation', async () => {
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({
        clientInformation: makeClientInfo({ client_id: 'existing-client' }),
        authorizationServer: 'https://existing.example.com',
        scopes: ['read', 'write'],
      }),
    );
    await provider.saveTokens(makeTokens({ access_token: 'refreshed' }));

    const record = await store.read('jira');
    expect(record?.clientInformation).toEqual(makeClientInfo({ client_id: 'existing-client' }));
    expect(record?.authorizationServer).toBe('https://existing.example.com');
    expect(record?.scopes).toEqual(['read', 'write']);
    expect(record?.tokens).toEqual(makeTokens({ access_token: 'refreshed' }));
  });

  it('updates obtainedAt to the current time', async () => {
    const { provider, store } = makeProvider();
    await provider.saveClientInformation(makeClientInfo());
    provider.setAuthorizationServer('https://auth.example.com');
    const before = Date.now();
    await provider.saveTokens(makeTokens());
    const after = Date.now();
    const obtainedAt = new Date((await store.read('jira'))!.obtainedAt).getTime();
    expect(obtainedAt).toBeGreaterThanOrEqual(before);
    expect(obtainedAt).toBeLessThanOrEqual(after);
  });
});

describe('ToolBoxOAuthProvider.tokens (no cache)', () => {
  it('returns undefined for an unknown server', async () => {
    const { provider } = makeProvider();
    expect(await provider.tokens()).toBeUndefined();
  });

  it('picks up external writes without caching the first read', async () => {
    const { provider, store } = makeProvider();
    expect(await provider.tokens()).toBeUndefined();
    await store.write('jira', makeRecord({ tokens: makeTokens({ access_token: 'external' }) }));
    expect(await provider.tokens()).toEqual(makeTokens({ access_token: 'external' }));
  });
});

describe('ToolBoxOAuthProvider.suppressStoredTokensForReauth', () => {
  it('hides stored tokens without deleting them, then surfaces new tokens after saveTokens', async () => {
    const { provider, store } = makeProvider();
    await store.write('jira', makeRecord());
    expect(await provider.tokens()).toEqual(makeTokens());

    provider.suppressStoredTokensForReauth();
    expect(await provider.tokens()).toBeUndefined();
    // Suppression is in-memory only; the stored record is untouched.
    expect(await store.read('jira')).not.toBeNull();

    await provider.saveTokens(makeTokens({ access_token: 'reauthed' }));
    expect(await provider.tokens()).toEqual(makeTokens({ access_token: 'reauthed' }));
  });

  it('clears suppression when saveTokens fails so stored tokens resurface', async () => {
    // A failed re-auth (here: the keychain write throws) must not leave the
    // provider permanently suppressed — the still-valid stored tokens have to
    // become visible again rather than the provider being stuck unauthenticated.
    const backing = new InMemoryTokenStore();
    await backing.write('jira', makeRecord());
    const failingStore: TokenStore = {
      read: (name) => backing.read(name),
      write: () => Promise.reject(new Error('keychain unavailable')),
      delete: (name) => backing.delete(name),
      list: () => backing.list(),
      probe: () => backing.probe(),
    };
    const { provider } = makeProvider({ tokenStore: failingStore });

    provider.suppressStoredTokensForReauth();
    expect(await provider.tokens()).toBeUndefined();

    await expect(provider.saveTokens(makeTokens({ access_token: 'new' }))).rejects.toThrow(
      /keychain unavailable/,
    );

    expect(await provider.tokens()).toEqual(makeRecord().tokens);
  });
});

describe('ToolBoxOAuthProvider.state', () => {
  it('returns distinct UUID-shaped values', async () => {
    const { provider } = makeProvider();
    const a = await provider.state();
    const b = await provider.state();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe('ToolBoxOAuthProvider PKCE code verifier', () => {
  it('round-trips saveCodeVerifier then codeVerifier', async () => {
    const { provider } = makeProvider();
    await provider.saveCodeVerifier('verifier-xyz');
    expect(await provider.codeVerifier()).toBe('verifier-xyz');
  });

  it('throws when codeVerifier is requested before it is saved', async () => {
    const { provider } = makeProvider();
    await expect(provider.codeVerifier()).rejects.toThrow(/codeVerifier/);
  });
});

describe('ToolBoxOAuthProvider.redirectToAuthorization', () => {
  it('throws SuppressedRedirectError carrying the authorization URL', async () => {
    const { provider } = makeProvider();
    const url = new URL('https://auth.example.com/authorize?client_id=abc');
    await expect(provider.redirectToAuthorization(url)).rejects.toBeInstanceOf(
      SuppressedRedirectError,
    );
    try {
      await provider.redirectToAuthorization(url);
    } catch (err) {
      expect((err as SuppressedRedirectError).authorizationUrl.toString()).toBe(url.toString());
    }
  });
});
