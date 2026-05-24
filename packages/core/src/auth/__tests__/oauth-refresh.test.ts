import { afterEach, describe, expect, it } from 'vitest';

import { createNoopLogger } from '../../logging/logger.js';
import { runOAuthRefresh } from '../oauth-refresh.js';
import { InMemoryTokenStore, type StoredOAuthRecord, type TokenStore } from '../token-store.js';
import { startFakeOAuthServer, type FakeOAuthServer } from './__fixtures__/fake-oauth-server.js';

const SERVER_NAME = 'acme';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()?.();
  }
});

async function fakeServer(
  ...args: Parameters<typeof startFakeOAuthServer>
): Promise<FakeOAuthServer> {
  const server = await startFakeOAuthServer(...args);
  closers.push(() => server.close());
  return server;
}

function seedToken(
  store: InMemoryTokenStore,
  authorizationServer: string,
  resource?: string,
): Promise<void> {
  const record: StoredOAuthRecord = {
    schemaVersion: 2,
    clientInformation: { client_id: 'fake-client-id' },
    tokens: {
      access_token: 'old-access-token',
      token_type: 'Bearer',
      refresh_token: 'fake-refresh-token',
    },
    authorizationServer,
    scopes: ['read'],
    obtainedAt: '2020-01-01T00:00:00.000Z',
    ...(resource !== undefined ? { resource } : {}),
  };
  return store.write(SERVER_NAME, record);
}

describe('runOAuthRefresh', () => {
  it('refreshes the stored token and persists the rotated pair, preserving record metadata', async () => {
    const server = await fakeServer();
    const store = new InMemoryTokenStore();
    await seedToken(store, server.url.toString());

    const result = await runOAuthRefresh({
      serverName: SERVER_NAME,
      tokenStore: store,
      logger: createNoopLogger(),
    });

    expect(result).toEqual({ kind: 'success' });
    expect(server.tokenGrants).toEqual(['refresh_token']);
    const record = await store.read(SERVER_NAME);
    expect(record?.tokens.access_token).toBe('refreshed-access-token');
    expect(record?.tokens.refresh_token).toBe('rotated-refresh-token');
    expect(record?.authorizationServer).toBe(server.url.toString());
    expect(record?.scopes).toEqual(['read']);
    expect(record?.obtainedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('discovers metadata from the stored authorization server, never re-deriving it from a resource URL', async () => {
    // No serverUrl is supplied at all: the refresh must reach the token endpoint
    // purely via the authorization server persisted at login time. This is the
    // case that breaks when an implementation rediscovers from the resource
    // origin (unreachable when the resource server's metadata is down).
    const authServer = await fakeServer();
    const store = new InMemoryTokenStore();
    await seedToken(store, authServer.url.toString());

    const result = await runOAuthRefresh({
      serverName: SERVER_NAME,
      tokenStore: store,
      logger: createNoopLogger(),
    });

    expect(result).toEqual({ kind: 'success' });
    // Metadata was discovered straight from the stored authorization server.
    expect(authServer.discoveryCount()).toBe(1);
    expect(authServer.tokenGrants).toEqual(['refresh_token']);
    expect((await store.read(SERVER_NAME))?.tokens.access_token).toBe('refreshed-access-token');
  });

  it('replays the persisted resource indicator so a resource-bound server accepts the refresh', async () => {
    const server = await fakeServer({ requireResourceOnRefresh: true });
    const store = new InMemoryTokenStore();
    const resource = 'https://api.example.com/mcp';
    await seedToken(store, server.url.toString(), resource);

    const result = await runOAuthRefresh({
      serverName: SERVER_NAME,
      tokenStore: store,
      logger: createNoopLogger(),
    });

    expect(result).toEqual({ kind: 'success' });
    expect(server.tokenResources).toEqual([resource]);
    const record = await store.read(SERVER_NAME);
    expect(record?.tokens.access_token).toBe('refreshed-access-token');
    // The resource indicator must survive the refresh write so later refreshes
    // keep replaying it.
    expect(record?.resource).toBe(resource);
  });

  it('sends no resource indicator when the record carries none', async () => {
    const server = await fakeServer();
    const store = new InMemoryTokenStore();
    await seedToken(store, server.url.toString());

    const result = await runOAuthRefresh({
      serverName: SERVER_NAME,
      tokenStore: store,
      logger: createNoopLogger(),
    });

    expect(result).toEqual({ kind: 'success' });
    expect(server.tokenResources).toEqual([null]);
    expect((await store.read(SERVER_NAME))?.resource).toBeUndefined();
  });

  it('fails against a resource-bound server when the record carries no resource', async () => {
    // Guards the negative path: a record written without a resource must not
    // silently fabricate one, so a server that demands it rejects the refresh.
    const server = await fakeServer({ requireResourceOnRefresh: true });
    const store = new InMemoryTokenStore();
    await seedToken(store, server.url.toString());

    const result = await runOAuthRefresh({
      serverName: SERVER_NAME,
      tokenStore: store,
      logger: createNoopLogger(),
    });

    expect(result.kind).toBe('failed');
    expect((await store.read(SERVER_NAME))?.tokens.access_token).toBe('old-access-token');
  });

  it('reports failure and leaves the stored token untouched when the refresh grant is rejected', async () => {
    const server = await fakeServer({ rejectRefresh: true });
    const store = new InMemoryTokenStore();
    await seedToken(store, server.url.toString());

    const result = await runOAuthRefresh({
      serverName: SERVER_NAME,
      tokenStore: store,
      logger: createNoopLogger(),
    });

    expect(result.kind).toBe('failed');
    const record = await store.read(SERVER_NAME);
    expect(record?.tokens.access_token).toBe('old-access-token');
  });

  it('fails when no token is stored', async () => {
    const store = new InMemoryTokenStore();
    const result = await runOAuthRefresh({
      serverName: SERVER_NAME,
      tokenStore: store,
      logger: createNoopLogger(),
    });
    expect(result.kind).toBe('failed');
  });

  it('returns a failed result (not a rejection) when the token-store read throws', async () => {
    const throwing: TokenStore = {
      read: () => Promise.reject(new Error('keychain is locked')),
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      probe: () => Promise.resolve({ kind: 'ready' }),
    };

    const result = await runOAuthRefresh({
      serverName: SERVER_NAME,
      tokenStore: throwing,
      logger: createNoopLogger(),
    });

    expect(result).toEqual({ kind: 'failed', reason: 'keychain is locked' });
  });
});
