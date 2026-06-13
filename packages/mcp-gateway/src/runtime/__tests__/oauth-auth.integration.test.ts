import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { InMemoryTokenStore, withCredentialLock, type StoredOAuthRecord } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — `.mjs` fixture has no .d.ts; shape is described inline below.
import { startOAuthMcpServer } from '../../upstream-client/__tests__/__fixtures__/oauth-mcp-server.mjs';

import {
  connectHttpClient,
  createIntegrationHarness,
  makeIntegrationConfig,
  startHarness,
  waitFor,
} from './__fixtures__/integration-helpers.js';

interface OAuthMcpServer {
  url: string;
  issuer: string;
  validTokens: Set<string>;
  authHeaders: Array<string | null>;
  tokenGrants: string[];
  refreshCount: () => number;
  setRejectRefresh: (value: boolean) => void;
  close: () => Promise<void>;
}

const startServer = startOAuthMcpServer as (options?: {
  validTokens?: string[];
  rejectRefresh?: boolean;
}) => Promise<OAuthMcpServer>;

const harness = createIntegrationHarness();
const activeServers = new Set<OAuthMcpServer>();

afterEach(async () => {
  await harness.cleanup();
  for (const server of activeServers) {
    await server.close().catch(() => undefined);
  }
  activeServers.clear();
});

async function startUpstream(options?: {
  validTokens?: string[];
  rejectRefresh?: boolean;
}): Promise<OAuthMcpServer> {
  const server = await startServer(options);
  activeServers.add(server);
  return server;
}

function record(
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

function configFor(url: string): ReturnType<typeof makeIntegrationConfig> {
  return makeIntegrationConfig({
    servers: {
      demo: { type: 'http', enabled: true, url, auth: { type: 'oauth' } },
    },
  });
}

describe('gateway OAuth runtime', () => {
  it('connects with a stored token and calls a tool', async () => {
    const upstream = await startUpstream({ validTokens: ['tok-1'] });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.write(
      'demo',
      record(upstream.issuer, { access_token: 'tok-1', refresh_token: 'r1' }),
    );

    const { runtime, downstream } = await startHarness({
      config: configFor(upstream.url),
      harness,
      tokenStore,
    });

    expect(runtime.statusRegistry.get('demo')?.status.kind).toBe('connected');

    const client = await connectHttpClient(downstream.url, 'oauth-happy', harness);
    const result = await client.callTool({ name: 'demo__echo', arguments: { message: 'hi' } });
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
  }, 20_000);

  it('refreshes a stale token on connect and ends up connected', async () => {
    // Upstream only accepts the refreshed token; the seeded token is stale.
    const upstream = await startUpstream({ validTokens: ['refreshed-access-token'] });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.write(
      'demo',
      record(upstream.issuer, { access_token: 'stale', refresh_token: 'r1' }),
    );

    const { runtime } = await startHarness({
      config: configFor(upstream.url),
      harness,
      tokenStore,
    });

    expect(runtime.statusRegistry.get('demo')?.status.kind).toBe('connected');
    expect(upstream.tokenGrants).toContain('refresh_token');
    const stored = await tokenStore.read('demo');
    expect(stored?.tokens.access_token).toBe('refreshed-access-token');
  }, 20_000);

  it('refreshes a stale token from a downstream tool call and persists rotated tokens', async () => {
    const upstream = await startUpstream({ validTokens: ['refreshed-access-token'] });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.write(
      'demo',
      record(upstream.issuer, {
        access_token: 'stale-access-token',
        refresh_token: 'valid-refresh-token',
      }),
    );

    const { runtime, downstream } = await startHarness({
      config: configFor(upstream.url),
      harness,
      tokenStore,
      waitForServers: [],
    });
    await waitFor(() => runtime.statusRegistry.get('demo')?.status.kind === 'connected', 5000);

    const client = await connectHttpClient(downstream.url, 'oauth-refresh-call', harness);
    const result = await client.callTool({ name: 'demo__echo', arguments: { message: 'ok' } });

    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(upstream.tokenGrants).toContain('refresh_token');
    const stored = await tokenStore.read('demo');
    expect(stored?.tokens.access_token).toBe('refreshed-access-token');
    expect(runtime.statusRegistry.get('demo')?.status.kind).toBe('connected');
  }, 20_000);

  it('surfaces auth_expired on revoked refresh and recovers after fresh tokens are written', async () => {
    const upstream = await startUpstream({
      validTokens: ['fresh-login-token'],
      rejectRefresh: true,
    });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.write(
      'demo',
      record(upstream.issuer, {
        access_token: 'stale-access-token',
        refresh_token: 'revoked-refresh-token',
      }),
    );

    const { runtime, downstream } = await startHarness({
      config: configFor(upstream.url),
      harness,
      tokenStore,
      waitForServers: [],
    });
    await waitFor(() => runtime.statusRegistry.get('demo')?.status.kind === 'auth_expired', 5000);

    const client = await connectHttpClient(downstream.url, 'oauth-expired-recovery', harness);
    const expired = await client.callTool({
      name: 'demo__echo',
      arguments: { message: 'should fail' },
    });

    expect(expired.isError).toBe(true);
    expect(JSON.stringify(expired.content)).toContain('tlbx auth login demo');
    expect(runtime.statusRegistry.get('demo')?.status.kind).toBe('auth_expired');

    upstream.setRejectRefresh(false);
    await tokenStore.write(
      'demo',
      record(upstream.issuer, {
        access_token: 'fresh-login-token',
        refresh_token: 'fresh-refresh-token',
      }),
    );
    await waitFor(() => runtime.statusRegistry.get('demo')?.status.kind === 'connected', 5000);

    const recovered = await client.callTool({ name: 'demo__echo', arguments: { message: 'ok' } });

    expect(recovered.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(runtime.statusRegistry.get('demo')?.status.kind).toBe('connected');
  }, 20_000);

  it('routes the gateway token refresh through the per-server credential lock (P3-09)', async () => {
    // The runtime must thread its configDir down to the OAuth provider as the
    // credential-lock root, so a refresh persisting tokens contends on the
    // same per-name lock the CLI credential commands use. While the test holds
    // demo's lock the refresh cannot persist; releasing it lets the gateway
    // finish connecting and write the rotated tokens.
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tlbx-runtime-cred-lock-'));
    try {
      const upstream = await startUpstream({ validTokens: ['refreshed-access-token'] });
      const tokenStore = new InMemoryTokenStore();
      await tokenStore.write(
        'demo',
        record(upstream.issuer, { access_token: 'stale', refresh_token: 'r1' }),
      );

      let releaseLock = (): void => undefined;
      const lockGate = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let signalHeld = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      const lockHold = withCredentialLock(configDir, 'demo', async () => {
        signalHeld();
        await lockGate;
      });
      await held;

      const { runtime } = await startHarness({
        config: configFor(upstream.url),
        harness,
        tokenStore,
        configDir,
        waitForServers: [],
      });

      // The refresh grant lands, but its token save must wait on demo's lock.
      await waitFor(() => upstream.tokenGrants.includes('refresh_token'), 5000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await tokenStore.read('demo'))?.tokens.access_token).toBe('stale');

      releaseLock();
      await lockHold;
      await waitFor(() => runtime.statusRegistry.get('demo')?.status.kind === 'connected', 5000);
      expect((await tokenStore.read('demo'))?.tokens.access_token).toBe('refreshed-access-token');
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('enters auth_required when no token is stored at all', async () => {
    const upstream = await startUpstream({ validTokens: ['tok-1'] });
    const tokenStore = new InMemoryTokenStore();

    const { runtime } = await startHarness({
      config: configFor(upstream.url),
      harness,
      tokenStore,
      waitForServers: [],
    });

    await waitFor(() => runtime.statusRegistry.get('demo')?.status.kind === 'auth_required', 5000);
    expect(runtime.statusRegistry.get('demo')?.status.kind).toBe('auth_required');
  }, 20_000);
});
