import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { OAuthClientInformation, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it } from 'vitest';

import { withCredentialLock } from '../../config/lock.js';
import { createNoopLogger } from '../../logging/logger.js';
import {
  CredentialChangedDuringRefreshError,
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

/**
 * Marks the next saveTokens as an authorization-code (login) save. The SDK
 * always consumes the PKCE verifier immediately before exchanging the code, so
 * a save on a store with no existing record only happens on this path — a
 * refresh-grant save with no record aborts instead of resurrecting it (P3-09).
 */
async function simulateCodeExchange(provider: ToolBoxOAuthProvider): Promise<void> {
  await provider.saveCodeVerifier('verifier');
  await provider.codeVerifier();
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
    await simulateCodeExchange(provider);
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
    await simulateCodeExchange(provider);
    await expect(provider.saveTokens(makeTokens())).rejects.toThrow(/clientInformation/);
  });

  it('throws without an authorization server URL', async () => {
    const { provider } = makeProvider();
    await provider.saveClientInformation(makeClientInfo());
    await simulateCodeExchange(provider);
    await expect(provider.saveTokens(makeTokens())).rejects.toThrow(
      /without an authorization server URL/,
    );
  });

  it('persists the authorization server set via setAuthorizationServer', async () => {
    const { provider, store } = makeProvider();
    await provider.saveClientInformation(makeClientInfo());
    provider.setAuthorizationServer('https://issuer.example.com');
    await simulateCodeExchange(provider);
    await provider.saveTokens(makeTokens());
    expect((await store.read('jira'))?.authorizationServer).toBe('https://issuer.example.com');
  });

  it('uses opts.authorizationServer as a fallback', async () => {
    const { provider, store } = makeProvider({ authorizationServer: 'https://opts.example.com' });
    await provider.saveClientInformation(makeClientInfo());
    await simulateCodeExchange(provider);
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
    await simulateCodeExchange(provider);
    const before = Date.now();
    await provider.saveTokens(makeTokens());
    const after = Date.now();
    const obtainedAt = new Date((await store.read('jira'))!.obtainedAt).getTime();
    expect(obtainedAt).toBeGreaterThanOrEqual(before);
    expect(obtainedAt).toBeLessThanOrEqual(after);
  });

  it('clears the authorization-code resource marker when a token write fails', async () => {
    const backing = new InMemoryTokenStore();
    await backing.write(
      'jira',
      makeRecord({
        resource: 'https://current.example/mcp',
        tokens: makeTokens({ access_token: 'external', refresh_token: 'rt' }),
      }),
    );
    let rejectNextWrite = true;
    const flakyStore: TokenStore = {
      read: (name) => backing.read(name),
      write: (name, record) => {
        if (rejectNextWrite) {
          rejectNextWrite = false;
          return Promise.reject(new Error('keychain unavailable'));
        }
        return backing.write(name, record);
      },
      delete: (name) => backing.delete(name),
      list: () => backing.list(),
      probe: () => backing.probe(),
    };
    const { provider } = makeProvider({ tokenStore: flakyStore });
    provider.saveDiscoveryState({
      authorizationServerUrl: 'https://issuer.example/',
      resourceMetadata: {
        resource: 'https://stale.example/mcp',
        authorization_servers: ['https://issuer.example/'],
      },
    });
    await provider.saveClientInformation(makeClientInfo());
    await provider.saveCodeVerifier('verifier');
    await provider.codeVerifier();

    await expect(provider.saveTokens(makeTokens({ access_token: 'reauth' }))).rejects.toThrow(
      /keychain unavailable/,
    );
    await provider.saveTokens(makeTokens({ access_token: 'refreshed' }));

    const record = await backing.read('jira');
    expect(record?.tokens.access_token).toBe('refreshed');
    expect(record?.resource).toBe('https://current.example/mcp');
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
    await simulateCodeExchange(provider);
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

  it('replays the stored resource on refresh, ignoring a stale SDK-supplied (cached-discovery) resource', async () => {
    // The long-lived gateway provider can be handed a resource derived from
    // discovery cached in an earlier flow. After `tlbx auth login` rebinds the
    // stored resource, a refresh must send the current stored value, not the
    // stale cached one the SDK passes in.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({
        resource: 'https://b.example/mcp',
        tokens: makeTokens({ refresh_token: 'rt' }),
      }),
    );

    // Server-compatible but stale cached-discovery resource supplied by the SDK.
    const result = await provider.validateResourceURL(
      'https://b.example/mcp',
      'https://b.example/',
    );
    expect(result?.toString()).toBe('https://b.example/mcp');
  });

  it('omits the resource on refresh when the stored record no longer has one, despite a stale supplied value', async () => {
    // `tlbx auth login` removed the resource; a refresh must honor that and send
    // none rather than the resource the SDK derived from cached discovery.
    const { provider, store } = makeProvider();
    await store.write('jira', makeRecord({ tokens: makeTokens({ refresh_token: 'rt' }) }));

    const result = await provider.validateResourceURL(
      'https://b.example/mcp',
      'https://b.example/',
    );
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

describe('ToolBoxOAuthProvider credential-lock serialization (P3-09)', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function makeLockDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tlbx-cred-lock-'));
    tempDirs.push(dir);
    return dir;
  }

  it('aborts a refresh-grant save without writing when the stored record was removed mid-refresh', async () => {
    // The SDK read the stored refresh token and exchanged it at the token
    // endpoint; a `tlbx auth logout` then deleted the credential before the
    // refreshed pair was persisted. The save must not re-create the record the
    // user just removed.
    const { provider, store } = makeProvider();
    await store.write('jira', makeRecord({ tokens: makeTokens({ refresh_token: 'rt' }) }));
    await store.delete('jira');

    await expect(provider.saveTokens(makeTokens({ access_token: 'refreshed' }))).rejects.toThrow(
      /while a token refresh was in flight/,
    );
    expect(await store.read('jira')).toBeNull();
  });

  it('skips the save without clobbering or failing when a concurrent login replaced the record', async () => {
    // The SDK reads the refresh token and POSTs to the token endpoint outside
    // the credential lock. If `tlbx auth login` writes a fresh credential (new
    // refresh token) while that POST is in flight, the in-flight refresh — based
    // on the old refresh token — must not clobber the newer login. The replaced
    // record is still valid, so the save skips silently (no throw): the SDK's
    // retry re-reads and uses the login's token. The upstream client wraps each
    // operation in `withRefreshScope`, so the lineage read and the save share one
    // cell.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({ tokens: makeTokens({ access_token: 'old', refresh_token: 'rt0' }) }),
    );

    await expect(
      provider.withRefreshScope(async () => {
        // The SDK reads the refresh source before exchanging it.
        expect((await provider.tokens())?.refresh_token).toBe('rt0');

        // Concurrent login rebinds the credential to a fresh refresh token.
        await store.write(
          'jira',
          makeRecord({ tokens: makeTokens({ access_token: 'login', refresh_token: 'rt1' }) }),
        );

        return provider.saveTokens(
          makeTokens({ access_token: 'refreshed', refresh_token: 'rt-refreshed' }),
        );
      }),
    ).resolves.toBeUndefined();

    // The fresh login survives intact; the stale refresh did not clobber it.
    const record = await store.read('jira');
    expect(record?.tokens.access_token).toBe('login');
    expect(record?.tokens.refresh_token).toBe('rt1');
  });

  it('isolates refresh lineage per concurrent operation so a parallel read cannot clobber the winner', async () => {
    // The SDK reads tokens() (to attach a header or feed a refresh) and later
    // calls saveTokens() within one operation. The transport calls tokens() on
    // every request with no dedup, so a long-lived provider sees concurrent
    // reads from independent operations. Operation A's in-flight refresh lineage
    // (scoped via withRefreshScope) must not be corrupted by operation B's
    // parallel read of a newer (logged-in) record — otherwise A's stale save
    // would match the corrupted lineage and clobber B's login.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({ tokens: makeTokens({ access_token: 'a0', refresh_token: 'rt0' }) }),
    );

    let releaseASave = (): void => undefined;
    const aSaveGate = new Promise<void>((resolve) => {
      releaseASave = resolve;
    });

    // Operation A: reads its refresh source (rt0) in its own scope, then pauses
    // before persisting until B has run.
    const aOperation = provider.withRefreshScope(async (): Promise<unknown> => {
      const source = (await provider.tokens())?.refresh_token;
      expect(source).toBe('rt0');
      await aSaveGate;
      return provider.saveTokens(makeTokens({ access_token: 'refreshed', refresh_token: 'rt-r' }));
    });

    // Let A's tokens() read settle before B runs.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Operation B (its own scope): a concurrent login rebinds the credential,
    // then B reads tokens() — which would overwrite a shared lineage field with
    // rt1 and let A's stale save match the changed record and clobber it.
    await provider.withRefreshScope(async (): Promise<void> => {
      await store.write(
        'jira',
        makeRecord({ tokens: makeTokens({ access_token: 'login', refresh_token: 'rt1' }) }),
      );
      const bSource = (await provider.tokens())?.refresh_token;
      expect(bSource).toBe('rt1');
    });

    releaseASave();
    await aOperation;

    // A's stale refresh skipped its write and did not clobber B's login.
    const record = await store.read('jira');
    expect(record?.tokens.access_token).toBe('login');
    expect(record?.tokens.refresh_token).toBe('rt1');
  });

  it('does not clobber when a concurrent login rewrote the record even if the refresh token is unchanged', async () => {
    // A login that mints a fresh access token but happens to preserve the same
    // refresh token still rewrites the record (new access token + obtainedAt).
    // The lineage check compares a record fingerprint, not just the refresh
    // token, so the stale in-flight refresh detects the rewrite and skips its
    // write rather than clobbering that login.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({
        obtainedAt: '2026-01-01T00:00:00.000Z',
        tokens: makeTokens({ access_token: 'old', refresh_token: 'shared-rt' }),
      }),
    );

    await expect(
      provider.withRefreshScope(async () => {
        expect((await provider.tokens())?.refresh_token).toBe('shared-rt');
        // Concurrent login: same refresh token, new access token + obtainedAt.
        await store.write(
          'jira',
          makeRecord({
            obtainedAt: '2026-02-02T00:00:00.000Z',
            tokens: makeTokens({ access_token: 'login', refresh_token: 'shared-rt' }),
          }),
        );
        return provider.saveTokens(
          makeTokens({ access_token: 'refreshed', refresh_token: 'shared-rt' }),
        );
      }),
    ).resolves.toBeUndefined();

    expect((await store.read('jira'))?.tokens.access_token).toBe('login');
  });

  it('does not fail or clobber when an external write replaced the record mid-refresh', async () => {
    // A refresh is in flight when an external writer (a `tlbx auth login` /
    // `auth refresh` in another process) replaces the record. The in-flight
    // refresh, seeing the record changed by a writer that is not this provider,
    // must not fail (auth_expired) or clobber — it skips its write so the SDK
    // retry uses the external writer's now-current tokens.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({ tokens: makeTokens({ access_token: 'stale', refresh_token: 'rt0' }) }),
    );

    await expect(
      provider.withRefreshScope(async () => {
        // Loser captures the stale source.
        expect((await provider.tokens())?.refresh_token).toBe('rt0');
        // An external process replaces the record (not via this provider).
        await store.write(
          'jira',
          makeRecord({
            obtainedAt: '2026-03-03T00:00:00.000Z',
            tokens: makeTokens({ access_token: 'external', refresh_token: 'rt-ext' }),
          }),
        );
        return provider.saveTokens(makeTokens({ access_token: 'loser', refresh_token: 'rt-lose' }));
      }),
    ).resolves.toBeUndefined();

    // The external write is intact; the in-flight refresh did not overwrite it.
    expect((await store.read('jira'))?.tokens.access_token).toBe('external');
  });

  it('skips (does not clobber) when a same-provider concurrent refresh already wrote', async () => {
    // Two gateway operations on the SAME provider refresh the same credential. The
    // first to acquire the lock wins; the loser, seeing the record changed, skips
    // rather than overwriting. Its rotation is dropped, which is benign under
    // standard OAuth (the winner's rotation is a valid sibling, or reuse detection
    // revokes the grant and recovery re-logs in). The client cannot order server
    // rotations, so skip — which never clobbers — is the safe default.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({ tokens: makeTokens({ access_token: 'a0', refresh_token: 'rt0' }) }),
    );

    let releaseASave = (): void => undefined;
    const aSaveGate = new Promise<void>((resolve) => {
      releaseASave = resolve;
    });

    // Operation A reads rt0, then pauses before persisting.
    const aOperation = provider.withRefreshScope(async (): Promise<void> => {
      expect((await provider.tokens())?.refresh_token).toBe('rt0');
      await aSaveGate;
      await provider.saveTokens(makeTokens({ access_token: 'a', refresh_token: 'rt-a' }));
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Operation B (same provider) also refreshes from rt0 and writes first.
    await provider.withRefreshScope(async (): Promise<void> => {
      expect((await provider.tokens())?.refresh_token).toBe('rt0');
      await provider.saveTokens(makeTokens({ access_token: 'b', refresh_token: 'rt-b' }));
    });
    expect((await store.read('jira'))?.tokens.access_token).toBe('b');

    releaseASave();
    await aOperation;

    // A saw the record replaced by B and skipped; B's write stands.
    expect((await store.read('jira'))?.tokens.access_token).toBe('b');
  });

  it('does not clobber a re-login the gateway already refreshed when a stale pre-login refresh lands', async () => {
    // A's refresh started from the OLD credential (rt0). The user then re-logs in
    // (R1), and the gateway refreshes THAT login once. When A's stale save finally
    // lands, the record has been replaced, so A skips rather than clobbering the
    // refreshed re-login.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({ tokens: makeTokens({ access_token: 'old', refresh_token: 'rt0' }) }),
    );

    let releaseASave = (): void => undefined;
    const aSaveGate = new Promise<void>((resolve) => {
      releaseASave = resolve;
    });

    // A reads the old credential (rt0), then pauses before persisting.
    const aOperation = provider.withRefreshScope(async (): Promise<void> => {
      expect((await provider.tokens())?.refresh_token).toBe('rt0');
      await aSaveGate;
      await provider.saveTokens(makeTokens({ access_token: 'a-stale', refresh_token: 'rt-a' }));
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // External re-login replaces the credential.
    await store.write(
      'jira',
      makeRecord({
        obtainedAt: '2026-07-07T00:00:00.000Z',
        tokens: makeTokens({ access_token: 'login', refresh_token: 'rt1' }),
      }),
    );

    // The gateway refreshes the new login once.
    await provider.withRefreshScope(async (): Promise<void> => {
      expect((await provider.tokens())?.refresh_token).toBe('rt1');
      await provider.saveTokens(makeTokens({ access_token: 'b-fresh', refresh_token: 'rt-b' }));
    });
    expect((await store.read('jira'))?.tokens.access_token).toBe('b-fresh');

    releaseASave();
    await aOperation;

    // A's stale refresh skipped rather than clobbering the refreshed re-login.
    expect((await store.read('jira'))?.tokens.access_token).toBe('b-fresh');
  });

  it('persists an unscoped refresh when the record is unchanged (rotation-safe)', async () => {
    // A background SSE-stream reconnect refreshes without a withRefreshScope.
    // When nothing changed concurrently, it must still PERSIST the rotated
    // tokens — skipping would leave a stale refresh token and risk the server's
    // reuse detection revoking the credential chain. The serial fallback lineage
    // confirms the record is unchanged, so the write proceeds.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({ tokens: makeTokens({ access_token: 'old', refresh_token: 'rt0' }) }),
    );

    // Unscoped read captures the source via the fallback lineage.
    expect((await provider.tokens())?.refresh_token).toBe('rt0');
    await provider.saveTokens(makeTokens({ access_token: 'rotated', refresh_token: 'rt1' }));

    const record = await store.read('jira');
    expect(record?.tokens.access_token).toBe('rotated');
    expect(record?.tokens.refresh_token).toBe('rt1');
  });

  it('guards an unscoped refresh save against a concurrent replacement via the fallback lineage', async () => {
    // Same unscoped (background reconnect) path, but a concurrent `tlbx auth
    // login` replaces the record between the read and the save. The fallback
    // lineage lets the guard detect the change and skip the stale write rather
    // than clobbering the login.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({ tokens: makeTokens({ access_token: 'old', refresh_token: 'rt0' }) }),
    );

    expect((await provider.tokens())?.refresh_token).toBe('rt0');
    await store.write(
      'jira',
      makeRecord({ tokens: makeTokens({ access_token: 'login', refresh_token: 'rt1' }) }),
    );

    await expect(
      provider.saveTokens(makeTokens({ access_token: 'refreshed', refresh_token: 'rt-r' })),
    ).resolves.toBeUndefined();

    expect((await store.read('jira'))?.tokens.access_token).toBe('login');
  });

  it('does not let a concurrent scoped read corrupt an unscoped refresh’s fallback lineage', async () => {
    // The fallback lineage is only written by unscoped reads; a concurrent
    // scoped operation uses its own per-operation cell and must not overwrite
    // the fallback an in-flight unscoped refresh relies on.
    const { provider, store } = makeProvider();
    await store.write(
      'jira',
      makeRecord({ tokens: makeTokens({ access_token: 'old', refresh_token: 'rt0' }) }),
    );

    // Unscoped read seeds the fallback with rt0's fingerprint.
    expect((await provider.tokens())?.refresh_token).toBe('rt0');

    // The record is rewritten, then a concurrent scoped operation reads the new
    // record into its own cell. If that scoped read leaked into the fallback, the
    // unscoped save below would match the current record and clobber it.
    await store.write(
      'jira',
      makeRecord({ tokens: makeTokens({ access_token: 'newer', refresh_token: 'rt9' }) }),
    );
    await provider.withRefreshScope(async () => {
      expect((await provider.tokens())?.refresh_token).toBe('rt9');
    });

    // The unscoped save's source is still rt0 (fallback intact), which no longer
    // matches the current record (rt9), so it skips rather than clobbering.
    await expect(
      provider.saveTokens(makeTokens({ access_token: 'rotated', refresh_token: 'rt1' })),
    ).resolves.toBeUndefined();
    expect((await store.read('jira'))?.tokens.access_token).toBe('newer');
  });

  it('translates credential-lock contention into a retryable CredentialChangedDuringRefreshError', async () => {
    // A long-running credential command (e.g. `tlbx auth login` waiting on the
    // browser) holds the per-name lock past the gateway refresh's acquire
    // timeout. The refresh must not surface a raw ConfigLockError (a generic
    // upstream failure); it translates to CredentialChangedDuringRefreshError,
    // which the gateway classifies as a retryable auth condition.
    const dir = await makeLockDir();
    const { provider, store } = makeProvider({
      credentialLockRoot: dir,
      credentialLockOptions: { timeoutMs: 100, pollMs: 10 },
    });
    await store.write('jira', makeRecord({ tokens: makeTokens({ refresh_token: 'rt' }) }));

    let releaseHolder = (): void => undefined;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const holder = withCredentialLock(dir, 'jira', async () => {
      signalHeld();
      await holderGate;
    });
    await held;

    await provider.withRefreshScope(async () => {
      await provider.tokens();
      await expect(
        provider.saveTokens(makeTokens({ access_token: 'refreshed', refresh_token: 'rt' })),
      ).rejects.toBeInstanceOf(CredentialChangedDuringRefreshError);
    });

    releaseHolder();
    await holder;
    // The contended save did not persist.
    expect((await store.read('jira'))?.tokens.access_token).toBe('access-1');
  });

  it('serializes the saveTokens read-modify-write against a concurrent locked delete', async () => {
    // Gateway refresh racing `tlbx auth logout`: logout's locked read+delete
    // must not land between saveTokens' read and write — otherwise the write
    // resurrects the credential the user just removed.
    const dir = await makeLockDir();
    const backing = new InMemoryTokenStore();
    await backing.write('jira', makeRecord({ tokens: makeTokens({ refresh_token: 'rt' }) }));

    let releaseRead = (): void => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let signalReadInFlight = (): void => undefined;
    const readInFlight = new Promise<void>((resolve) => {
      signalReadInFlight = resolve;
    });
    let gateArmed = true;
    const gatedStore: TokenStore = {
      read: async (name) => {
        if (gateArmed) {
          gateArmed = false;
          signalReadInFlight();
          await readGate;
        }
        return backing.read(name);
      },
      write: (name, record) => backing.write(name, record),
      delete: (name) => backing.delete(name),
      list: () => backing.list(),
      probe: () => backing.probe(),
    };

    const { provider } = makeProvider({ tokenStore: gatedStore, credentialLockRoot: dir });
    const savePromise = provider.saveTokens(makeTokens({ access_token: 'refreshed' }));
    await readInFlight;

    // Logout-style locked delete for the same name, started while the save's
    // read-modify-write is mid-flight. It must wait for the save to finish.
    const logoutPromise = withCredentialLock(dir, 'jira', () => backing.delete('jira'));
    // Give the delete a chance to (incorrectly) cut ahead before the save's
    // read resumes; with the lock in place it cannot.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseRead();
    await Promise.all([savePromise, logoutPromise]);

    // Logout ran last under the lock, so the credential stays deleted.
    expect(await backing.read('jira')).toBeNull();
  });

  it('does not block a save on another server name’s credential lock', async () => {
    const dir = await makeLockDir();
    const { provider, store } = makeProvider({ credentialLockRoot: dir });
    await store.write('jira', makeRecord({ tokens: makeTokens({ refresh_token: 'rt' }) }));

    let releaseHold = (): void => undefined;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let signalHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const holdPromise = withCredentialLock(dir, 'other', async () => {
      signalHeld();
      await holdGate;
    });
    await held;

    // While "other" is locked, a save for "jira" must complete promptly.
    await provider.saveTokens(makeTokens({ access_token: 'refreshed' }));
    expect((await store.read('jira'))?.tokens.access_token).toBe('refreshed');

    releaseHold();
    await holdPromise;
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
