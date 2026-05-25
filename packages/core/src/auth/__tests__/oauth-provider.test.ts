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
    schemaVersion: 2,
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

describe('ToolBoxOAuthProvider.invalidateCredentials', () => {
  it("scope 'tokens' hides stored tokens in-memory without deleting the record", async () => {
    const { provider, store } = makeProvider();
    await store.write('jira', makeRecord());

    provider.invalidateCredentials('tokens');

    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.clientInformation()).toEqual(makeClientInfo());
    expect(await store.read('jira')).not.toBeNull();
  });

  it("scope 'client' forces re-registration by hiding stored client information", async () => {
    const { provider, store } = makeProvider();
    await store.write('jira', makeRecord());

    provider.invalidateCredentials('client');

    expect(await provider.clientInformation()).toBeUndefined();
    // A fresh registration supersedes the invalidation.
    await provider.saveClientInformation(makeClientInfo({ client_id: 'reregistered' }));
    expect(await provider.clientInformation()).toEqual(
      makeClientInfo({ client_id: 'reregistered' }),
    );
  });

  it("scope 'verifier' drops the saved PKCE verifier", async () => {
    const { provider } = makeProvider();
    await provider.saveCodeVerifier('verifier-xyz');

    provider.invalidateCredentials('verifier');

    await expect(provider.codeVerifier()).rejects.toThrow(/codeVerifier requested before/);
  });

  it("scope 'all' hides tokens and client information together", async () => {
    const { provider, store } = makeProvider();
    await store.write('jira', makeRecord());

    provider.invalidateCredentials('all');

    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.clientInformation()).toBeUndefined();
    expect(await store.read('jira')).not.toBeNull();
  });

  it("scope 'discovery' is a no-op since discovery state is never cached", async () => {
    const { provider, store } = makeProvider();
    await store.write('jira', makeRecord());

    provider.invalidateCredentials('discovery');

    expect(await provider.tokens()).toEqual(makeTokens());
    expect(await provider.clientInformation()).toEqual(makeClientInfo());
  });
});

describe('ToolBoxOAuthProvider discovery state', () => {
  it('round-trips saveDiscoveryState and persists the discovered authorization server', async () => {
    const { provider, store } = makeProvider();
    provider.saveDiscoveryState({ authorizationServerUrl: 'https://issuer.example/auth/' });
    expect(provider.discoveryState()).toEqual({
      authorizationServerUrl: 'https://issuer.example/auth/',
    });

    await provider.saveClientInformation(makeClientInfo());
    await provider.saveTokens(makeTokens());
    expect((await store.read('jira'))?.authorizationServer).toBe('https://issuer.example/auth/');
  });

  it("invalidateCredentials('discovery') clears the cached discovery state", () => {
    const { provider } = makeProvider();
    provider.saveDiscoveryState({ authorizationServerUrl: 'https://issuer.example/' });
    provider.invalidateCredentials('discovery');
    expect(provider.discoveryState()).toBeUndefined();
  });

  it('persists the RFC 8707 resource indicator from the discovered protected-resource metadata', async () => {
    const { provider, store } = makeProvider();
    provider.saveDiscoveryState({
      authorizationServerUrl: 'https://issuer.example/',
      resourceMetadata: {
        resource: 'https://api.example.com/mcp',
        authorization_servers: ['https://issuer.example/'],
      },
    });

    await provider.saveClientInformation(makeClientInfo());
    await provider.saveCodeVerifier('verifier'); // interactive authorization-code flow
    await provider.codeVerifier(); // SDK consumes it during the code exchange
    await provider.saveTokens(makeTokens());

    expect((await store.read('jira'))?.resource).toBe('https://api.example.com/mcp');
  });

  it('persists no resource when the discovered metadata advertises none', async () => {
    const { provider, store } = makeProvider();
    provider.saveDiscoveryState({ authorizationServerUrl: 'https://issuer.example/' });

    await provider.saveClientInformation(makeClientInfo());
    await provider.saveCodeVerifier('verifier');
    await provider.codeVerifier();
    await provider.saveTokens(makeTokens());

    expect((await store.read('jira'))?.resource).toBeUndefined();
  });

  it('preserves an existing record resource on a refresh re-save (no code exchange)', async () => {
    // A refresh grant performs no authorization-code exchange, so it must keep
    // the resource captured at login rather than dropping it.
    const { provider, store } = makeProvider();
    await store.write('jira', makeRecord({ resource: 'https://api.example.com/mcp' }));

    await provider.saveTokens(makeTokens({ access_token: 'refreshed' }));

    const record = await store.read('jira');
    expect(record?.tokens.access_token).toBe('refreshed');
    expect(record?.resource).toBe('https://api.example.com/mcp');
  });

  it('does not overwrite a newer externally-stored resource on a refresh re-save', async () => {
    // The gateway provider is long-lived: the SDK reuses its cached discovery
    // across 401-refreshes, so discoveryStateCache stays set from the initial
    // connect. If an external `tlbx auth login` rebinds the server to a new
    // resource (read-through picks up the new record), a later refresh re-save
    // (no code exchange) must not resurrect the stale session-cached resource.
    const { provider, store } = makeProvider();
    provider.saveDiscoveryState({
      authorizationServerUrl: 'https://issuer.example/',
      resourceMetadata: {
        resource: 'https://a.example/mcp',
        authorization_servers: ['https://issuer.example/'],
      },
    });
    await provider.saveClientInformation(makeClientInfo());
    await provider.saveCodeVerifier('verifier'); // initial interactive login
    await provider.codeVerifier();
    await provider.saveTokens(makeTokens({ access_token: 'first' }));
    expect((await store.read('jira'))?.resource).toBe('https://a.example/mcp');

    // External relogin rebinds to resource B (no new discovery on this provider).
    await store.write(
      'jira',
      makeRecord({
        resource: 'https://b.example/mcp',
        tokens: makeTokens({ access_token: 'external', refresh_token: 'rt' }),
      }),
    );

    // A later refresh re-save: the SDK reused cached discovery, so no fresh
    // saveDiscoveryState ran before this save.
    await provider.saveTokens(makeTokens({ access_token: 'refreshed' }));

    const record = await store.read('jira');
    expect(record?.tokens.access_token).toBe('refreshed');
    expect(record?.resource).toBe('https://b.example/mcp');
  });

  it('does not treat discovery as authoritative when the flow ran no code exchange (stored token satisfied auth)', async () => {
    // A connect that runs discovery but is satisfied by an already-valid stored
    // token performs no code exchange and no token save. The fresh-discovery
    // signal must not linger on this long-lived provider: a later refresh save,
    // after an external relogin rebinds the resource, must keep the newer stored
    // value rather than the stale session-cached discovery.
    const { provider, store } = makeProvider();
    provider.saveDiscoveryState({
      authorizationServerUrl: 'https://issuer.example/',
      resourceMetadata: {
        resource: 'https://a.example/mcp',
        authorization_servers: ['https://issuer.example/'],
      },
    });
    // No saveCodeVerifier and no saveTokens here: auth() was satisfied by the
    // stored token.

    // External relogin rebinds to resource B.
    await store.write(
      'jira',
      makeRecord({
        resource: 'https://b.example/mcp',
        tokens: makeTokens({ access_token: 'external', refresh_token: 'rt' }),
      }),
    );

    // A later refresh save (refresh grant — no code verifier).
    await provider.saveTokens(makeTokens({ access_token: 'refreshed' }));

    expect((await store.read('jira'))?.resource).toBe('https://b.example/mcp');
  });

  it('does not treat an abandoned authorize (verifier saved, never exchanged) as authoritative', async () => {
    // A redirect flow that starts but never completes saves a PKCE verifier yet
    // never exchanges a code. On a reused (gateway) provider that marker must not
    // linger and make a later refresh save treat stale cached discovery as
    // authoritative over a newer externally-stored resource.
    const { provider, store } = makeProvider();
    provider.saveDiscoveryState({
      authorizationServerUrl: 'https://issuer.example/',
      resourceMetadata: {
        resource: 'https://a.example/mcp',
        authorization_servers: ['https://issuer.example/'],
      },
    });
    await provider.saveClientInformation(makeClientInfo());
    await provider.saveCodeVerifier('verifier'); // authorize started…
    // …but never exchanged: no codeVerifier() consumption, no saveTokens.

    // External relogin rebinds to resource B.
    await store.write(
      'jira',
      makeRecord({
        resource: 'https://b.example/mcp',
        tokens: makeTokens({ access_token: 'external', refresh_token: 'rt' }),
      }),
    );

    // A later refresh save (refresh grant — no code exchange).
    await provider.saveTokens(makeTokens({ access_token: 'refreshed' }));

    expect((await store.read('jira'))?.resource).toBe('https://b.example/mcp');
  });

  it('drops a stale resource when reauth rediscovers metadata that advertises none', async () => {
    // Interactive reauth (or a server retargeted under the same name) runs fresh
    // discovery. If that discovery selects no resource, the freshly authenticated
    // record must NOT inherit the previously stored resource, or every later
    // refresh would replay a stale audience (invalid_target / wrong-audience token).
    const { provider, store } = makeProvider();
    await store.write('jira', makeRecord({ resource: 'https://api.example.com/mcp' }));

    provider.saveDiscoveryState({ authorizationServerUrl: 'https://issuer.example/' });
    await provider.saveClientInformation(makeClientInfo());
    await provider.saveCodeVerifier('verifier'); // interactive reauth
    await provider.codeVerifier();
    await provider.saveTokens(makeTokens({ access_token: 'reauthed' }));

    const record = await store.read('jira');
    expect(record?.tokens.access_token).toBe('reauthed');
    expect(record?.resource).toBeUndefined();
  });
});

describe('ToolBoxOAuthProvider.validateResourceURL', () => {
  it('returns the discovered protected-resource resource when present', async () => {
    const { provider } = makeProvider();
    const result = await provider.validateResourceURL(
      'https://api.example.com/mcp',
      'https://api.example.com/mcp',
    );
    expect(result?.toString()).toBe('https://api.example.com/mcp');
  });

  it('throws when the discovered resource is incompatible with the server', async () => {
    const { provider } = makeProvider();
    await expect(
      provider.validateResourceURL('https://api.example.com/mcp', 'https://evil.example/'),
    ).rejects.toThrow(/does not match/);
  });

  it('replays the persisted resource on a refresh when discovery found no metadata', async () => {
    // The gateway SDK refresh selects the token-request resource here. When the
    // server's protected-resource metadata is not rediscovered (resource arg
    // undefined), the resource login persisted must still be sent so a
    // resource-bound server accepts the refresh.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({
        resource: 'https://api.example.com/mcp',
        tokens: makeTokens({ refresh_token: 'rt' }),
      }),
    );

    const result = await provider.validateResourceURL('https://api.example.com/mcp', undefined);
    expect(result?.toString()).toBe('https://api.example.com/mcp');
  });

  it('omits a persisted resource that does not match the current server URL', async () => {
    // Server retargeted under the same name: the stored resource is for a
    // different origin and must not be replayed as the audience. validateResourceURL
    // overrides the SDK's default validation entirely, so it must re-run the
    // compatibility check itself.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({
        resource: 'https://old-origin.example/mcp',
        tokens: makeTokens({ refresh_token: 'rt' }),
      }),
    );

    const result = await provider.validateResourceURL('https://new-origin.example/', undefined);
    expect(result).toBeUndefined();
  });

  it('sends no resource during suppressed reauth even if one is stored', async () => {
    // Interactive reauth suppresses stored tokens; the persisted resource must
    // not be replayed, so a server that dropped its resource is honored.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({
        resource: 'https://api.example.com/mcp',
        tokens: makeTokens({ refresh_token: 'rt' }),
      }),
    );
    provider.suppressStoredTokensForReauth();

    const result = await provider.validateResourceURL('https://api.example.com/', undefined);
    expect(result).toBeUndefined();
  });

  it('returns undefined when discovery found none and there is no refreshable stored record', async () => {
    const { provider } = makeProvider();
    const result = await provider.validateResourceURL('https://api.example.com/', undefined);
    expect(result).toBeUndefined();
  });

  it('returns undefined when the stored record has a resource but no refresh token', async () => {
    const { provider, store } = makeProvider();
    await store.write('jira', makeRecord({ resource: 'https://api.example.com/mcp' }));

    const result = await provider.validateResourceURL('https://api.example.com/', undefined);
    expect(result).toBeUndefined();
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
