import { getEventListeners } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNoopLogger } from '../../logging/logger.js';
import { startCallbackServer } from '../oauth-callback-server.js';
import { runOAuthLogin, type RunOAuthLoginInput } from '../oauth-login.js';
import { InMemoryTokenStore, type StoredOAuthRecord } from '../token-store.js';
import {
  startFakeOAuthServer,
  startFakeResourceServer,
  type FakeOAuthServer,
  type FakeResourceServer,
} from './__fixtures__/fake-oauth-server.js';

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

async function fakeResourceServer(
  ...args: Parameters<typeof startFakeResourceServer>
): Promise<FakeResourceServer> {
  const server = await startFakeResourceServer(...args);
  closers.push(() => server.close());
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

  it('does not refresh or overwrite a stored token when already aborted', async () => {
    // A pre-aborted signal must short-circuit before any side-effecting work:
    // no token-endpoint call, no overwrite of the existing record.
    const server = await fakeServer();
    const store = new InMemoryTokenStore();
    await seedToken(store, server.url.origin);
    const openBrowser = vi.fn(() => Promise.resolve());

    const result = await runOAuthLogin(
      baseInput(server, { tokenStore: store, openBrowser, abortSignal: AbortSignal.abort() }),
    );

    expect(result).toEqual({ kind: 'cancelled', reason: 'aborted by caller' });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(server.tokenGrants).toEqual([]);
    const record = await store.read(SERVER_NAME);
    expect(record?.tokens.access_token).toBe('old-access-token');
  });

  it('does not open the browser when aborted during the discovery/DCR phase', async () => {
    // Abort fires while the SDK is still doing pre-browser network work, after
    // the entry-level check has already passed. The browser must never open.
    const controller = new AbortController();
    const server = await fakeServer({ onRegister: () => controller.abort() });
    const store = new InMemoryTokenStore();
    const openBrowser = vi.fn(() => Promise.resolve());

    const result = await runOAuthLogin(
      baseInput(server, { tokenStore: store, openBrowser, abortSignal: controller.signal }),
    );

    expect(result.kind).toBe('cancelled');
    expect(openBrowser).not.toHaveBeenCalled();
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

  it('falls back to the browser flow when refreshing a stored token returns invalid_grant', async () => {
    const server = await fakeServer({ rejectRefresh: true });
    const store = new InMemoryTokenStore();
    await seedToken(store, server.url.origin);
    const openBrowser = fetchingBrowser();

    const result = await runOAuthLogin(baseInput(server, { tokenStore: store, openBrowser }));

    expect(result).toEqual({ kind: 'success' });
    // Refresh is attempted and rejected, then the SDK retries through the
    // authorization-code flow once invalidateCredentials hides the bad token.
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(server.tokenGrants).toEqual(['refresh_token', 'authorization_code']);
    const record = await store.read(SERVER_NAME);
    expect(record?.tokens.access_token).toBe('fake-access-token');
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

  it('threads resourceMetadataUrl through the code-exchange phase too', async () => {
    // The auth server is discoverable ONLY via the explicit resourceMetadataUrl;
    // the MCP resource server origin does not serve OAuth endpoints. If any
    // auth() phase drops the metadata URL it rediscovers against the bare origin
    // and the token exchange targets a dead endpoint.
    const authServer = await fakeServer();
    const resourceServer = await fakeResourceServer({ authorizationServers: [authServer.url] });
    const store = new InMemoryTokenStore();

    const result = await runOAuthLogin(
      baseInput(authServer, {
        serverUrl: resourceServer.url,
        resourceMetadataUrl: resourceServer.resourceMetadataUrl,
        tokenStore: store,
      }),
    );

    expect(result).toEqual({ kind: 'success' });
    expect(authServer.tokenGrants).toEqual(['authorization_code']);
    expect((await store.read(SERVER_NAME))?.tokens.access_token).toBe('fake-access-token');
  });

  it('does not leak abort listeners across logins that reuse one signal', async () => {
    const server = await fakeServer();
    const controller = new AbortController();

    for (let i = 0; i < 3; i++) {
      const result = await runOAuthLogin(
        baseInput(server, { tokenStore: new InMemoryTokenStore(), abortSignal: controller.signal }),
      );
      expect(result).toEqual({ kind: 'success' });
    }

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not hang when openBrowser stalls and no abort signal is provided', async () => {
    const server = await fakeServer();
    const store = new InMemoryTokenStore();
    // A browser opener that never resolves, with no abort signal to rescue it.
    // The callback timeout must still terminate the flow.
    const openBrowser = vi.fn(() => new Promise<void>(() => undefined));

    const result = await runOAuthLogin(
      baseInput(server, { tokenStore: store, openBrowser, callbackTimeoutMs: 80 }),
    );

    expect(result.kind).toBe('failed');
    expect((result as { reason: string }).reason).toMatch(/timed out/i);
    expect(await store.read(SERVER_NAME)).toBeNull();
  });

  it('classifies a server error as failed even when its message mentions "cancelled"', async () => {
    // Without an abort signal, a genuine token-exchange failure whose text
    // happens to contain "cancelled" must be reported as failed, not silently
    // swallowed as a user cancellation.
    const server = await fakeServer({ rejectCodeExchange: true });
    const store = new InMemoryTokenStore();

    const result = await runOAuthLogin(baseInput(server, { tokenStore: store }));

    expect(result.kind).toBe('failed');
    expect(await store.read(SERVER_NAME)).toBeNull();
  });

  it('reuses the registered client across forceReauth with a fresh loopback redirect', async () => {
    const server = await fakeServer();
    const store = new InMemoryTokenStore();

    const first = await runOAuthLogin(baseInput(server, { tokenStore: store }));
    expect(first).toEqual({ kind: 'success' });
    expect(server.registrationCount()).toBe(1);

    // Re-login (identity switch). The DCR client is intentionally reused — no
    // second registration — and the authorization request carries a fresh
    // loopback redirect_uri (a new ephemeral callback port). RFC 8252 §7.3
    // requires servers to accept any loopback port for the registered client,
    // so re-registering per login would only churn server-side clients.
    const second = await runOAuthLogin(baseInput(server, { tokenStore: store, forceReauth: true }));
    expect(second).toEqual({ kind: 'success' });
    expect(server.registrationCount()).toBe(1);

    const authz = server.authorizeParams();
    expect(authz).toHaveLength(2);
    for (const params of authz) {
      expect(params.clientId).toBe('fake-client-id');
      const redirect = new URL(params.redirectUri ?? '');
      expect(redirect.hostname).toBe('127.0.0.1');
      expect(redirect.pathname).toBe('/callback');
    }
  });

  it('fails and writes no token when the redirect state does not match', async () => {
    const server = await fakeServer({ tamperState: true });
    const store = new InMemoryTokenStore();

    const result = await runOAuthLogin(baseInput(server, { tokenStore: store }));

    expect(result.kind).toBe('failed');
    expect((result as { reason: string }).reason).toMatch(/state/i);
    expect(await store.read(SERVER_NAME)).toBeNull();
  });

  it('closes the callback server promptly when aborted mid-flow so a fresh listener can bind', async () => {
    const server = await fakeServer();
    const controller = new AbortController();
    // Abort at the browser-open step — after the callback server is listening —
    // and never complete the redirect, so cancellation (not a code) ends the flow.
    const openBrowser = vi.fn(() => {
      controller.abort();
      return new Promise<void>(() => undefined);
    });

    const result = await runOAuthLogin(
      baseInput(server, { openBrowser, abortSignal: controller.signal }),
    );
    expect(result).toEqual({ kind: 'cancelled', reason: 'aborted by caller' });
    expect(openBrowser).toHaveBeenCalledTimes(1);

    // The await above resolving at all proves close() did not hang; binding a
    // fresh callback server confirms the listener was released.
    const fresh = await startCallbackServer({ logger: createNoopLogger() });
    expect(fresh.host).toBe('127.0.0.1');
    await fresh.close();
  });
});
