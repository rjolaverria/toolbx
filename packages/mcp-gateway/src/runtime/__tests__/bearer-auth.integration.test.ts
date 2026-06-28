import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — `.mjs` fixture has no .d.ts; shape is described inline below.
import { startHttpEchoServer } from '../../upstream-client/__tests__/__fixtures__/http-echo-server.mjs';

import {
  connectHttpClient,
  createIntegrationHarness,
  makeIntegrationConfig,
  startHarness,
  waitFor,
} from './__fixtures__/integration-helpers.js';

interface HttpEchoServerOptions {
  requireBearerToken?: string;
}
interface HttpEchoServer {
  url: string;
  close: () => Promise<void>;
}
const startServer = startHttpEchoServer as (
  options?: HttpEchoServerOptions,
) => Promise<HttpEchoServer>;

const harness = createIntegrationHarness();
const activeFixtures = new Set<HttpEchoServer>();

afterEach(async () => {
  await harness.cleanup();
  for (const server of activeFixtures) {
    await server.close().catch(() => undefined);
  }
  activeFixtures.clear();
});

async function startUpstreamFixture(token: string): Promise<HttpEchoServer> {
  const server = await startServer({ requireBearerToken: token });
  activeFixtures.add(server);
  return server;
}

describe('gateway bearer auth env-var resolution', () => {
  it('resolves `${env:TOKEN}` from processEnv and sends Authorization: Bearer to the upstream', async () => {
    const token = 'integration-test-secret';
    const upstream = await startUpstreamFixture(token);

    const config = makeIntegrationConfig({
      servers: {
        secured: {
          type: 'http',
          enabled: true,
          url: upstream.url,
          auth: { type: 'bearer', tokenEnv: 'TOOLBX_IT_BEARER_TOKEN' },
        },
      },
    });

    const { runtime, downstream } = await startHarness({
      config,
      harness,
      processEnv: { ...process.env, TOOLBX_IT_BEARER_TOKEN: token },
    });

    const client = await connectHttpClient(downstream.url, 'toolbx-bearer-it', harness);

    const list = await client.listTools();
    expect(list.tools.map((t) => t.name).sort()).toEqual(['secured__echo', 'secured__slow']);

    const result = await client.callTool({
      name: 'secured__echo',
      arguments: { message: 'authenticated' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'authenticated' }]);

    expect(runtime.statusRegistry.get('secured')?.status.kind).toBe('connected');
  }, 15_000);

  it('surfaces auth_required when the bearer env var is not set', async () => {
    // The fixture still demands the bearer header — the gateway should never
    // actually send a request because the missing env var short-circuits the
    // connect attempt.
    const upstream = await startUpstreamFixture('some-token-that-wont-be-used');

    const config = makeIntegrationConfig({
      servers: {
        secured: {
          type: 'http',
          enabled: true,
          url: upstream.url,
          auth: { type: 'bearer', tokenEnv: 'TOOLBX_IT_BEARER_MISSING' },
        },
      },
    });

    const harness2 = createIntegrationHarness();
    try {
      // Don't wait for `connected` — the upstream session bails out into
      // `auth_required` before it ever opens a transport.
      const { runtime, downstream } = await startHarness({
        config,
        harness: harness2,
        // Use a processEnv map that explicitly omits TOOLBX_IT_BEARER_MISSING.
        // We strip TOOLBX_IT_BEARER_MISSING in case the developer happens to
        // have it set; the rest of process.env passes through unchanged.
        processEnv: stripEnvVar(process.env, 'TOOLBX_IT_BEARER_MISSING'),
        waitForServers: [],
      });

      await waitFor(
        () => runtime.statusRegistry.get('secured')?.status.kind === 'auth_required',
        5000,
      );

      const entry = runtime.statusRegistry.get('secured');
      expect(entry?.status.kind).toBe('auth_required');
      expect(entry?.authStatus).toBe('required');
      if (entry?.status.kind === 'auth_required') {
        expect(entry.status.reason).toContain('TOOLBX_IT_BEARER_MISSING');
      }

      // The gateway is still accepting client connections; tools/list just
      // returns an empty set because the only upstream isn't connected.
      const client = await connectHttpClient(downstream.url, 'toolbx-bearer-missing-it', harness2);
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toEqual([]);
    } finally {
      await harness2.cleanup();
    }
  }, 15_000);
});

function stripEnvVar(env: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  delete copy[name];
  return copy;
}
