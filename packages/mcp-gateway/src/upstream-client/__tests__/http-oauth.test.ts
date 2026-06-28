import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createNoopLogger,
  InMemoryTokenStore,
  withCredentialLock,
  type StoredOAuthRecord,
  type TokenStore,
} from '@toolbx/core';
import { afterEach, describe, expect, it } from 'vitest';

import { UpstreamAuthExpiredError, UpstreamAuthRequiredError } from '../errors.js';
import { createHttpUpstreamClient } from '../http.js';
import type { HttpServerConfig } from '@toolbx/core';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — `.mjs` fixture has no .d.ts; shape is described inline below.
import { startOAuthMcpServer } from './__fixtures__/oauth-mcp-server.mjs';

interface OAuthMcpServer {
  url: string;
  issuer: string;
  validTokens: Set<string>;
  authHeaders: Array<string | null>;
  tokenGrants: string[];
  refreshCount: () => number;
  close: () => Promise<void>;
}

const start = startOAuthMcpServer as (options?: {
  validTokens?: string[];
  rejectRefresh?: boolean;
  refreshAccessToken?: string;
}) => Promise<OAuthMcpServer>;

const activeServers = new Set<OAuthMcpServer>();

afterEach(async () => {
  for (const server of activeServers) {
    await server.close().catch(() => undefined);
  }
  activeServers.clear();
});

async function startServer(options?: {
  validTokens?: string[];
  rejectRefresh?: boolean;
}): Promise<OAuthMcpServer> {
  const server = await start(options);
  activeServers.add(server);
  return server;
}

function makeRecord(
  issuer: string,
  tokens: Partial<StoredOAuthRecord['tokens']> & { access_token: string },
): StoredOAuthRecord {
  return {
    schemaVersion: 2,
    clientInformation: { client_id: 'fake-client-id' },
    tokens: { token_type: 'Bearer', ...tokens },
    authorizationServer: issuer,
    scopes: [],
    obtainedAt: new Date().toISOString(),
  };
}

function makeClient(url: string, tokenStore: TokenStore, opts?: { credentialLockRoot?: string }) {
  const config: HttpServerConfig = {
    type: 'http',
    enabled: true,
    url,
    auth: { type: 'oauth' },
  };
  return createHttpUpstreamClient(config, {
    logger: createNoopLogger(),
    serverName: 'demo',
    tokenStore,
    connectTimeoutMs: 10_000,
    ...(opts?.credentialLockRoot !== undefined
      ? { credentialLockRoot: opts.credentialLockRoot }
      : {}),
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('createHttpUpstreamClient — OAuth', () => {
  it('attaches the stored access token as a Bearer header on every request', async () => {
    const upstream = await startServer({ validTokens: ['fake-access-token'] });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.write(
      'demo',
      makeRecord(upstream.issuer, { access_token: 'fake-access-token', refresh_token: 'r' }),
    );

    const client = makeClient(upstream.url, tokenStore);
    await client.connect();
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(['echo']);
    const result = await client.callTool('echo', { message: 'hi' });
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);

    expect(upstream.authHeaders.every((h) => h === 'Bearer fake-access-token')).toBe(true);
    expect(upstream.tokenGrants).toEqual([]);
    await client.disconnect();
  }, 15_000);

  it('refreshes on a 401 and retries with the refreshed token', async () => {
    // Upstream only accepts the *refreshed* token. The seeded access token is
    // stale, so the first request 401s and the SDK refreshes via the provider.
    const upstream = await startServer({ validTokens: ['refreshed-access-token'] });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.write(
      'demo',
      makeRecord(upstream.issuer, {
        access_token: 'stale-access-token',
        refresh_token: 'valid-refresh-token',
      }),
    );

    const client = makeClient(upstream.url, tokenStore);
    await client.connect();
    const result = await client.callTool('echo', { message: 'recovered' });
    expect(result.content).toEqual([{ type: 'text', text: 'recovered' }]);

    expect(upstream.tokenGrants).toContain('refresh_token');
    const stored = await tokenStore.read('demo');
    expect(stored?.tokens.access_token).toBe('refreshed-access-token');
    await client.disconnect();
  }, 15_000);

  it('throws UpstreamAuthExpiredError when refresh is rejected (revoked refresh token)', async () => {
    const upstream = await startServer({
      validTokens: ['refreshed-access-token'],
      rejectRefresh: true,
    });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.write(
      'demo',
      makeRecord(upstream.issuer, {
        access_token: 'stale-access-token',
        refresh_token: 'revoked-refresh-token',
      }),
    );

    const client = makeClient(upstream.url, tokenStore);
    await expect(client.connect()).rejects.toBeInstanceOf(UpstreamAuthExpiredError);
  }, 15_000);

  it('throws UpstreamAuthExpiredError when there is no refresh token to use', async () => {
    const upstream = await startServer({ validTokens: ['refreshed-access-token'] });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.write(
      'demo',
      makeRecord(upstream.issuer, { access_token: 'stale-access-token' }),
    );

    const client = makeClient(upstream.url, tokenStore);
    await expect(client.connect()).rejects.toBeInstanceOf(UpstreamAuthExpiredError);
    // No refresh_token means the SDK never hits the token endpoint with a
    // refresh grant.
    expect(upstream.tokenGrants).not.toContain('refresh_token');
  }, 15_000);

  it('throws UpstreamAuthRequiredError when no token is stored at all', async () => {
    const upstream = await startServer({ validTokens: ['refreshed-access-token'] });
    const tokenStore = new InMemoryTokenStore();

    const client = makeClient(upstream.url, tokenStore);
    await expect(client.connect()).rejects.toBeInstanceOf(UpstreamAuthRequiredError);
  }, 15_000);

  it('does not resurrect a record deleted mid-refresh and classifies it as auth_required (P3-09)', async () => {
    // A logout wins the credential lock just before the refresh persists its
    // result: the provider's locked read inside saveTokens finds no record.
    // The refreshed tokens must NOT be written back, and the failure surfaces
    // as auth_required (no stored credential), not a generic connect error.
    const upstream = await startServer({ validTokens: ['refreshed-access-token'] });
    const backing = new InMemoryTokenStore();
    await backing.write(
      'demo',
      makeRecord(upstream.issuer, {
        access_token: 'stale-access-token',
        refresh_token: 'valid-refresh-token',
      }),
    );

    // Simulate the logout: the first store read after the refresh grant lands
    // (the provider's load inside saveTokens) observes the record deleted.
    let logoutPending = true;
    const store: TokenStore = {
      read: async (name) => {
        if (logoutPending && upstream.tokenGrants.includes('refresh_token')) {
          logoutPending = false;
          await backing.delete(name);
        }
        return backing.read(name);
      },
      write: (name, record) => backing.write(name, record),
      delete: (name) => backing.delete(name),
      list: () => backing.list(),
      probe: () => backing.probe(),
    };

    const client = makeClient(upstream.url, store);
    await expect(client.connect()).rejects.toBeInstanceOf(UpstreamAuthRequiredError);
    // The user's logout sticks: the refreshed pair was never persisted.
    expect(await backing.read('demo')).toBeNull();
  }, 15_000);

  it('holds the per-server credential lock across the refresh token save (P3-09)', async () => {
    // The gateway client must thread credentialLockRoot down to its OAuth
    // provider so an SDK-driven refresh contends on the same per-name lock the
    // CLI credential commands use. While the test holds demo's lock, the
    // refresh cannot persist; releasing the lock lets it complete.
    const lockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tlbx-gw-cred-lock-'));
    try {
      const upstream = await startServer({ validTokens: ['refreshed-access-token'] });
      const tokenStore = new InMemoryTokenStore();
      await tokenStore.write(
        'demo',
        makeRecord(upstream.issuer, {
          access_token: 'stale-access-token',
          refresh_token: 'valid-refresh-token',
        }),
      );

      let releaseLock = (): void => undefined;
      const lockGate = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let signalHeld = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      const lockHold = withCredentialLock(lockDir, 'demo', async () => {
        signalHeld();
        await lockGate;
      });
      await held;

      const client = makeClient(upstream.url, tokenStore, { credentialLockRoot: lockDir });
      const connectPromise = client.connect();
      // Wait until the refresh grant has hit the token endpoint, then give the
      // save a chance to (incorrectly) land while the lock is held.
      await waitFor(() => upstream.tokenGrants.includes('refresh_token'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await tokenStore.read('demo'))?.tokens.access_token).toBe('stale-access-token');

      releaseLock();
      await lockHold;
      await connectPromise;
      expect((await tokenStore.read('demo'))?.tokens.access_token).toBe('refreshed-access-token');
      await client.disconnect();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('classifies a ping-time refresh failure as UpstreamAuthExpiredError', async () => {
    const upstream = await startServer({
      validTokens: ['fake-access-token'],
      rejectRefresh: true,
    });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.write(
      'demo',
      makeRecord(upstream.issuer, {
        access_token: 'fake-access-token',
        refresh_token: 'revoked-refresh-token',
      }),
    );

    const client = makeClient(upstream.url, tokenStore);
    await client.connect();

    // The access token is revoked server-side mid-session, so the next
    // keepalive ping 401s and the SDK's refresh attempt is rejected. The ping
    // path must classify this the same way connect/callTool do.
    upstream.validTokens.delete('fake-access-token');
    await expect(client.ping()).rejects.toBeInstanceOf(UpstreamAuthExpiredError);
    await client.disconnect();
  }, 15_000);
});
