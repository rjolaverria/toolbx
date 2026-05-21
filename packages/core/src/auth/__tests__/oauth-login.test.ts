import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNoopLogger } from '../../logging/logger.js';
import { startCallbackServer } from '../oauth-callback-server.js';
import { runOAuthLogin, type RunOAuthLoginInput } from '../oauth-login.js';
import { InMemoryTokenStore, type StoredOAuthRecord } from '../token-store.js';
import { startFakeOAuthServer, type FakeOAuthServer } from './__fixtures__/fake-oauth-server.js';

const SERVER_NAME = 'acme';

const servers: FakeOAuthServer[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function fakeServer(
  ...args: Parameters<typeof startFakeOAuthServer>
): Promise<FakeOAuthServer> {
  const server = await startFakeOAuthServer(...args);
  servers.push(server);
  return server;
}

/** Browser stub that drives the redirect by fetching the authorization URL. */
function fetchingBrowser() {
  return vi.fn(async (url: URL) => {
    await fetch(url);
  });
}

function baseInput(
  server: FakeOAuthServer,
  overrides: Partial<RunOAuthLoginInput> = {},
): RunOAuthLoginInput {
  return {
    serverName: SERVER_NAME,
    serverUrl: server.url,
    tokenStore: new InMemoryTokenStore(),
    logger: createNoopLogger(),
    openBrowser: fetchingBrowser(),
    callbackTimeoutMs: 10_000,
    ...overrides,
  };
}

function seedToken(store: InMemoryTokenStore, authorizationServer: string): Promise<void> {
  const record: StoredOAuthRecord = {
    schemaVersion: 1,
    clientInformation: { client_id: 'preexisting-client' },
    tokens: {
      access_token: 'old-access-token',
      token_type: 'Bearer',
      refresh_token: 'old-refresh-token',
    },
    authorizationServer,
    scopes: [],
    obtainedAt: new Date().toISOString(),
  };
  return store.write(SERVER_NAME, record);
}

describe('runOAuthLogin', () => {
  it('completes the browser flow and persists the issued tokens', async () => {
    const server = await fakeServer();
    const store = new InMemoryTokenStore();
    const result = await runOAuthLogin(baseInput(server, { tokenStore: store }));

    expect(result).toEqual({ kind: 'success' });
    const record = await store.read(SERVER_NAME);
    expect(record?.tokens.access_token).toBe('fake-access-token');
    expect(record?.tokens.refresh_token).toBe('fake-refresh-token');
    // Discovery falls back to the MCP server origin (normalized to a root URL)
    // as the authorization server, per the SDK's legacy-MCP behaviour.
    expect(record?.authorizationServer).toBe(server.url.toString());
    expect(server.tokenGrants).toEqual(['authorization_code']);
  });

  it('cancels and writes no token when aborted before the redirect arrives', async () => {
    const server = await fakeServer();
    const store = new InMemoryTokenStore();
    const openBrowser = vi.fn(() => Promise.resolve());

    const result = await runOAuthLogin(
      baseInput(server, { tokenStore: store, openBrowser, abortSignal: AbortSignal.abort() }),
    );

    expect(result).toEqual({ kind: 'cancelled', reason: 'aborted by caller' });
    expect(await store.read(SERVER_NAME)).toBeNull();
  });

  it('reports cancellation and writes no token on an access_denied redirect', async () => {
    const server = await fakeServer({ authorizeError: 'access_denied' });
    const store = new InMemoryTokenStore();

    const result = await runOAuthLogin(baseInput(server, { tokenStore: store }));

    expect(result.kind).toBe('cancelled');
    expect((result as { reason: string }).reason).toMatch(/access_denied/);
    expect(await store.read(SERVER_NAME)).toBeNull();
  });

  it('refreshes an existing token without opening the browser', async () => {
    const server = await fakeServer();
    const store = new InMemoryTokenStore();
    await seedToken(store, server.url.origin);
    const openBrowser = vi.fn(() => Promise.resolve());

    const result = await runOAuthLogin(baseInput(server, { tokenStore: store, openBrowser }));

    expect(result).toEqual({ kind: 'success' });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(server.tokenGrants).toEqual(['refresh_token']);
    const record = await store.read(SERVER_NAME);
    expect(record?.tokens.access_token).toBe('refreshed-access-token');
  });

  it('forces the browser handshake when forceReauth is set despite a stored token', async () => {
    const server = await fakeServer();
    const store = new InMemoryTokenStore();
    await seedToken(store, server.url.origin);
    const openBrowser = fetchingBrowser();

    const result = await runOAuthLogin(
      baseInput(server, { tokenStore: store, openBrowser, forceReauth: true }),
    );

    expect(result).toEqual({ kind: 'success' });
    // forceReauth suppresses the stored token, so the SDK runs the full
    // authorization-code flow instead of refreshing.
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(server.tokenGrants).toEqual(['authorization_code']);
    const record = await store.read(SERVER_NAME);
    expect(record?.tokens.access_token).toBe('fake-access-token');
  });

  it('fails and writes no token when the redirect state does not match', async () => {
    const server = await fakeServer({ tamperState: true });
    const store = new InMemoryTokenStore();

    const result = await runOAuthLogin(baseInput(server, { tokenStore: store }));

    expect(result.kind).toBe('failed');
    expect((result as { reason: string }).reason).toMatch(/state/i);
    expect(await store.read(SERVER_NAME)).toBeNull();
  });

  it('closes the callback server promptly on abort so a fresh listener can bind', async () => {
    const server = await fakeServer();
    const result = await runOAuthLogin(
      baseInput(server, {
        openBrowser: vi.fn(() => Promise.resolve()),
        abortSignal: AbortSignal.abort(),
      }),
    );
    expect(result.kind).toBe('cancelled');

    // If the callback server had leaked, this would still succeed (ephemeral
    // ports), but the await above resolving at all proves close() did not hang.
    const fresh = await startCallbackServer({ logger: createNoopLogger() });
    expect(fresh.host).toBe('127.0.0.1');
    await fresh.close();
  });
});
