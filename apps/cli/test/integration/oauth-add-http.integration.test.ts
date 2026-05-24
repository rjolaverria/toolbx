import * as fs from 'node:fs/promises';
import * as http from 'node:http';

import {
  createNoopLogger,
  DEFAULT_CONFIG,
  InMemoryTokenStore,
  loadConfig,
  probeUpstreamAuth,
  runOAuthLogin,
  saveConfig,
  type RunOAuthLoginInput,
  type RunOAuthLoginResult,
  type TokenStore,
} from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  runAddHttp,
  type AddHttpOptions,
  type ServerAddDeps,
} from '../../src/commands/server-add.js';

import {
  startFakeOAuthServer,
  type FakeOAuthServer,
} from '../../../../packages/core/src/auth/__tests__/__fixtures__/fake-oauth-server.js';

import { makeTempConfig, type TempConfigHandle } from './helpers.js';

interface AddHttpHarness {
  readonly deps: ServerAddDeps;
  readonly stderr: { value: string };
  readonly stdout: { value: string };
}

const tempConfigs: TempConfigHandle[] = [];
const oauthServers: FakeOAuthServer[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()?.();
  }
  while (oauthServers.length > 0) {
    await oauthServers.pop()?.close();
  }
  while (tempConfigs.length > 0) {
    await tempConfigs.pop()?.cleanup();
  }
});

async function fakeOAuthServer(): Promise<FakeOAuthServer> {
  const server = await startFakeOAuthServer();
  oauthServers.push(server);
  return server;
}

async function tempConfig(): Promise<TempConfigHandle> {
  const handle = await makeTempConfig(DEFAULT_CONFIG);
  tempConfigs.push(handle);
  return handle;
}

function addHttpOptions(
  url: URL,
  overrides: Partial<Omit<AddHttpOptions, 'url'>> = {},
): AddHttpOptions {
  return { url: url.toString(), ...overrides };
}

function makeDeps(
  configPath: string,
  tokenStore: TokenStore,
  runLogin: (input: RunOAuthLoginInput) => Promise<RunOAuthLoginResult>,
): AddHttpHarness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const deps: ServerAddDeps = {
    resolvePath: () => configPath,
    cwd: () => process.cwd(),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    logger: createNoopLogger(),
    createTokenStore: () => tokenStore,
    probeAuth: (url) => probeUpstreamAuth(url, { logger: createNoopLogger() }),
    runOAuthLogin: runLogin,
    saveConfig: (config, target) => saveConfig(config, target),
  };
  return { deps, stdout, stderr };
}

function browserLogin(): (input: RunOAuthLoginInput) => Promise<RunOAuthLoginResult> {
  return (input) =>
    runOAuthLogin({
      ...input,
      openBrowser: async (url) => {
        await fetch(url);
      },
      callbackTimeoutMs: 10_000,
    });
}

function cancellingLogin(): (input: RunOAuthLoginInput) => Promise<RunOAuthLoginResult> {
  return (input) =>
    runOAuthLogin({
      ...input,
      openBrowser: async () => {
        await Promise.resolve();
        process.emit('SIGINT', 'SIGINT');
      },
      callbackTimeoutMs: 10_000,
    });
}

async function startFailingProbeServer(): Promise<URL> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.end('probe exploded');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind failing probe server');
  }
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function startProtectedMcpProbeServer(authServer: FakeOAuthServer): Promise<URL> {
  const prmPath = '/.well-known/oauth-protected-resource/mcp';
  let base = new URL('http://127.0.0.1/');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (url.pathname === prmPath) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          resource: base.origin,
          authorization_servers: [authServer.url.toString()],
        }),
      );
      return;
    }
    res.statusCode = 401;
    res.setHeader(
      'www-authenticate',
      `Bearer resource_metadata="${new URL(prmPath, base).toString()}"`,
    );
    res.end('authorization required');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind protected MCP probe server');
  }
  base = new URL(`http://127.0.0.1:${address.port}/`);
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

describe('OAuth add-http integration', () => {
  it('registers an OAuth HTTP server from discovery and persists tokens', async () => {
    const authServer = await fakeOAuthServer();
    const protectedMcpUrl = await startProtectedMcpProbeServer(authServer);
    const config = await tempConfig();
    const tokenStore = new InMemoryTokenStore();
    const harness = makeDeps(config.target, tokenStore, browserLogin());

    const code = await runAddHttp('github', addHttpOptions(protectedMcpUrl), harness.deps);

    expect(code, harness.stderr.value).toBe(0);
    expect(harness.stderr.value).toBe('');
    expect(harness.stdout.value).toContain('OAuth required for github');
    expect(harness.stdout.value).toContain('registered (OAuth)');
    expect((await loadConfig(config.target)).servers.github).toEqual({
      type: 'http',
      enabled: true,
      url: protectedMcpUrl.toString(),
      auth: { type: 'oauth' },
    });
    expect((await tokenStore.read('github'))?.tokens.access_token).toBe('fake-access-token');
    expect(authServer.tokenGrants).toEqual(['authorization_code']);
  });

  it('leaves config and token store unchanged when OAuth is cancelled', async () => {
    const authServer = await fakeOAuthServer();
    const protectedMcpUrl = await startProtectedMcpProbeServer(authServer);
    const config = await tempConfig();
    const before = await fs.readFile(config.target, 'utf8');
    const tokenStore = new InMemoryTokenStore();
    const harness = makeDeps(config.target, tokenStore, cancellingLogin());

    const code = await runAddHttp('github', addHttpOptions(protectedMcpUrl), harness.deps);

    expect(code, harness.stderr.value).toBe(2);
    expect(harness.stderr.value).toContain('Authentication cancelled');
    expect(await fs.readFile(config.target, 'utf8')).toBe(before);
    expect(await tokenStore.read('github')).toBeNull();
  });

  it('does not start OAuth or mutate state when discovery degrades', async () => {
    const config = await tempConfig();
    const before = await fs.readFile(config.target, 'utf8');
    const failingUrl = await startFailingProbeServer();
    const tokenStore = new InMemoryTokenStore();
    let loginCalls = 0;
    const harness = makeDeps(config.target, tokenStore, async () => {
      await Promise.resolve();
      loginCalls += 1;
      return { kind: 'failed', reason: 'should not run' };
    });

    const code = await runAddHttp('github', addHttpOptions(failingUrl), harness.deps);

    expect(code).toBe(4);
    expect(loginCalls).toBe(0);
    expect(harness.stderr.value).toContain('HTTP 500');
    expect(harness.stderr.value).toContain('probe exploded');
    expect(await fs.readFile(config.target, 'utf8')).toBe(before);
    expect(await tokenStore.read('github')).toBeNull();
  });

  it('bypasses the unauthenticated probe for explicit OAuth auth', async () => {
    const authServer = await fakeOAuthServer();
    const config = await tempConfig();
    const tokenStore = new InMemoryTokenStore();
    let probeCalls = 0;
    const harness = makeDeps(config.target, tokenStore, browserLogin());
    harness.deps.probeAuth = async (url) => {
      probeCalls += 1;
      return probeUpstreamAuth(url, { logger: createNoopLogger() });
    };

    const code = await runAddHttp(
      'github',
      addHttpOptions(authServer.url, { auth: 'oauth' }),
      harness.deps,
    );

    expect(code).toBe(0);
    expect(probeCalls).toBe(0);
    expect((await loadConfig(config.target)).servers.github).toMatchObject({
      type: 'http',
      auth: { type: 'oauth' },
    });
    expect((await tokenStore.read('github'))?.tokens.access_token).toBe('fake-access-token');
  });
});
