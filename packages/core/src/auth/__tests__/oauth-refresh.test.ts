import { afterEach, describe, expect, it } from 'vitest';

import { createNoopLogger } from '../../logging/logger.js';
import { runOAuthRefresh } from '../oauth-refresh.js';
import { InMemoryTokenStore, type StoredOAuthRecord } from '../token-store.js';
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

function seedToken(store: InMemoryTokenStore, authorizationServer: string): Promise<void> {
  const record: StoredOAuthRecord = {
    schemaVersion: 1,
    clientInformation: { client_id: 'fake-client-id' },
    tokens: {
      access_token: 'old-access-token',
      token_type: 'Bearer',
      refresh_token: 'fake-refresh-token',
    },
    authorizationServer,
    scopes: ['read'],
    obtainedAt: '2020-01-01T00:00:00.000Z',
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
});
