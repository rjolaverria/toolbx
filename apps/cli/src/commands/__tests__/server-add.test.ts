import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNoopLogger,
  DEFAULT_CONFIG,
  InMemoryTokenStore,
  loadConfig,
  saveConfig,
  type AuthHint,
  type RunOAuthLoginInput,
  type RunOAuthLoginResult,
  type StoredOAuthRecord,
} from '@toolbox/core';

import { writeToolManifest, type ToolManifest } from '@toolbox/custom-tools';

import {
  runAddHttp,
  runAddStdio,
  type AddHttpOptions,
  type AddStdioOptions,
  type ServerAddDeps,
} from '../server-add.js';

const tempDirs: string[] = [];

/** Seeds a custom-tool manifest with one tool under the given namespace. */
async function seedToolNamespace(target: string, namespace: string): Promise<void> {
  const entry: ToolManifest = {
    name: 'thing',
    namespace,
    exposedName: `${namespace}__thing`,
    title: 'Thing',
    description: 'A custom tool.',
    entry: `tools/${namespace}/thing.ts`,
    runtime: 'node',
    enabled: false,
    timeoutMs: 30000,
    permissions: { network: false, filesystem: false, env: [] },
  };
  await writeToolManifest(path.dirname(target), [entry]);
}

async function makeTempConfig(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-cli-server-add-'));
  tempDirs.push(dir);
  const target = path.join(dir, 'config.json');
  await saveConfig(DEFAULT_CONFIG, target);
  return target;
}

interface Harness {
  deps: ServerAddDeps;
  store: InMemoryTokenStore;
  stdout: { value: string };
  stderr: { value: string };
}

/**
 * Server-add deps wired against an in-memory token store. `probeAuth` defaults
 * to `none` (the common discovery outcome) and `runOAuthLogin` defaults to
 * throwing so a test that reaches the OAuth flow without stubbing it fails
 * loudly; each test reassigns the field it exercises.
 */
function makeHarness(
  target: string,
  store: InMemoryTokenStore = new InMemoryTokenStore(),
): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const deps: ServerAddDeps = {
    resolvePath: () => target,
    cwd: () => path.dirname(target),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    logger: createNoopLogger(),
    createTokenStore: () => store,
    probeAuth: vi.fn(() => Promise.resolve<AuthHint>({ kind: 'none' })),
    runOAuthLogin: vi.fn(() => Promise.reject(new Error('runOAuthLogin not stubbed'))),
    saveConfig: (config, file) => saveConfig(config, file),
  };
  return { deps, store, stdout, stderr };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

function stdioOpts(overrides: Partial<AddStdioOptions> = {}): AddStdioOptions {
  return { ...overrides };
}

function httpOpts(url: string, overrides: Partial<AddHttpOptions> = {}): AddHttpOptions {
  return { url, ...overrides };
}

const sampleRecord: StoredOAuthRecord = {
  schemaVersion: 2,
  clientInformation: { client_id: 'cid' },
  tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' },
  authorizationServer: 'https://acme.test',
  scopes: [],
  obtainedAt: '2026-05-21T00:00:00.000Z',
};

const priorRecord: StoredOAuthRecord = {
  ...sampleRecord,
  tokens: { access_token: 'old', token_type: 'Bearer', refresh_token: 'old-refresh' },
};

/** A `runOAuthLogin` stub that writes `sampleRecord` and reports success. */
function loginSucceeds() {
  return vi.fn(async (input: RunOAuthLoginInput): Promise<RunOAuthLoginResult> => {
    await input.tokenStore.write(input.serverName, sampleRecord);
    return { kind: 'success' };
  });
}

/** The first input `runOAuthLogin` was called with, if any. */
function loginInput(h: Harness): RunOAuthLoginInput | undefined {
  return vi.mocked(h.deps.runOAuthLogin).mock.calls[0]?.[0];
}

describe('runAddStdio', () => {
  it('rejects a server name matching an imported custom-tool namespace', async () => {
    const target = await makeTempConfig();
    await seedToolNamespace(target, 'personal');
    const h = makeHarness(target);

    const code = await runAddStdio('personal', ['echo'], stdioOpts(), h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('collides with the namespace of an imported custom tool');
    const config = await loadConfig(target);
    expect(config.servers.personal).toBeUndefined();
  });

  it('writes the SPECS §4.4 github example entry', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);

    const code = await runAddStdio(
      'github',
      ['npx', '-y', '@modelcontextprotocol/server-github'],
      stdioOpts({
        env: ['GITHUB_PERSONAL_ACCESS_TOKEN=${env:GITHUB_PERSONAL_ACCESS_TOKEN}'],
        timeout: 60000,
      }),
      h.deps,
    );

    expect(code).toBe(0);
    const config = await loadConfig(target);
    expect(config.servers.github).toEqual({
      type: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${env:GITHUB_PERSONAL_ACCESS_TOKEN}' },
      timeoutMs: 60000,
    });
    expect(JSON.parse(h.stdout.value)).toEqual(config.servers.github);
    expect(h.stderr.value).toBe('');
  });

  it('appends --arg values after positional command tokens', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);

    const code = await runAddStdio(
      'custom',
      ['mybin', '--mode'],
      stdioOpts({ arg: ['fast', '--verbose'] }),
      h.deps,
    );

    expect(code).toBe(0);
    const config = await loadConfig(target);
    expect(config.servers.custom).toMatchObject({
      command: 'mybin',
      args: ['--mode', 'fast', '--verbose'],
    });
  });

  it('respects --disabled and omits unset optional fields', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);

    const code = await runAddStdio('off', ['mybin'], stdioOpts({ disabled: true }), h.deps);

    expect(code).toBe(0);
    const config = await loadConfig(target);
    expect(config.servers.off).toEqual({
      type: 'stdio',
      enabled: false,
      command: 'mybin',
      args: [],
    });
  });

  it('rejects empty command without modifying the config', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);

    const code = await runAddStdio('foo', [], stdioOpts(), h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Missing command');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('rejects malformed --env entries without modifying the config', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);

    const code = await runAddStdio(
      'foo',
      ['mybin'],
      stdioOpts({ env: ['NO_EQUALS_SIGN'] }),
      h.deps,
    );

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('--env');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('rejects invalid server names without modifying the config', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);

    const code = await runAddStdio('Bad Name!', ['mybin'], stdioOpts(), h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Invalid ToolBox config');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('errors when the config file is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-cli-server-add-missing-'));
    tempDirs.push(dir);
    const target = path.join(dir, 'config.json');
    const h = makeHarness(target);

    const code = await runAddStdio('foo', ['mybin'], stdioOpts(), h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('tlbx init');
    await expect(fs.stat(target)).rejects.toThrow();
  });
});

describe('runAddHttp — explicit --auth', () => {
  it('writes the SPECS §4.4 jira example entry (--auth bearer) without probing', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'none' }));

    const code = await runAddHttp(
      'jira',
      httpOpts('https://jira.example.com/mcp', {
        auth: 'bearer',
        tokenEnv: 'JIRA_MCP_TOKEN',
        timeout: 60000,
      }),
      h.deps,
    );

    expect(code).toBe(0);
    const config = await loadConfig(target);
    expect(config.servers.jira).toEqual({
      type: 'http',
      enabled: true,
      url: 'https://jira.example.com/mcp',
      auth: { type: 'bearer', tokenEnv: 'JIRA_MCP_TOKEN' },
      timeoutMs: 60000,
    });
    expect(JSON.parse(h.stdout.value)).toEqual(config.servers.jira);
    expect(h.stderr.value).toBe('');
    expect(h.deps.probeAuth).not.toHaveBeenCalled();
  });

  it('rejects --auth bearer without --token-env', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);

    const code = await runAddHttp(
      'jira',
      httpOpts('https://jira.example.com/mcp', { auth: 'bearer' }),
      h.deps,
    );

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('--token-env');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('rejects --token-env when auth is not bearer', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);

    const code = await runAddHttp(
      'jira',
      httpOpts('https://jira.example.com/mcp', { tokenEnv: 'X' }),
      h.deps,
    );

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('--auth bearer');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('writes an explicit --auth none entry without probing', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'none' }));

    const code = await runAddHttp(
      'svc',
      httpOpts('https://svc.example.com/mcp', { auth: 'none' }),
      h.deps,
    );

    expect(code).toBe(0);
    const config = await loadConfig(target);
    expect(config.servers.svc).toEqual({
      type: 'http',
      enabled: true,
      url: 'https://svc.example.com/mcp',
    });
    expect(h.deps.probeAuth).not.toHaveBeenCalled();
  });

  it('runs the OAuth flow for explicit --auth oauth without probing', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'none' }));
    h.deps.runOAuthLogin = loginSucceeds();

    const code = await runAddHttp(
      'acme',
      httpOpts('https://acme.test/mcp', { auth: 'oauth' }),
      h.deps,
    );

    expect(code).toBe(0);
    expect(h.deps.probeAuth).not.toHaveBeenCalled();
    expect(h.deps.runOAuthLogin).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'acme' }),
    );
    // Explicit --auth oauth skips the probe, so no resource-metadata URL is threaded.
    expect(loginInput(h)?.resourceMetadataUrl).toBeUndefined();
    const config = await loadConfig(target);
    expect(config.servers.acme).toEqual({
      type: 'http',
      enabled: true,
      url: 'https://acme.test/mcp',
      auth: { type: 'oauth' },
    });
    expect(await h.store.read('acme')).toEqual(sampleRecord);
    expect(h.stdout.value).toContain('registered (OAuth)');
  });

  it('serializes concurrent same-name OAuth registrations so only one logs in and the token matches the winner', async () => {
    // Two OAuth add-http for the same name race, sharing one config + token store.
    // The registration lock must admit exactly one: it logs in and registers; the
    // other bails at its pre-login duplicate check WITHOUT a browser flow, so it
    // never writes a competing token that could clobber the winner's credentials.
    const target = await makeTempConfig();
    const store = new InMemoryTokenStore();
    const h1 = makeHarness(target, store);
    const h2 = makeHarness(target, store);
    const recordA: StoredOAuthRecord = {
      ...sampleRecord,
      tokens: { access_token: 'A', token_type: 'Bearer', refresh_token: 'ra' },
    };
    const recordB: StoredOAuthRecord = {
      ...sampleRecord,
      tokens: { access_token: 'B', token_type: 'Bearer', refresh_token: 'rb' },
    };
    const makeLogin = (record: StoredOAuthRecord) =>
      vi.fn(async (input: RunOAuthLoginInput): Promise<RunOAuthLoginResult> => {
        await new Promise((r) => setTimeout(r, 10));
        await input.tokenStore.write(input.serverName, record);
        return { kind: 'success' };
      });
    h1.deps.runOAuthLogin = makeLogin(recordA);
    h2.deps.runOAuthLogin = makeLogin(recordB);

    const [c1, c2] = await Promise.all([
      runAddHttp('acme', httpOpts('https://acme.test/mcp', { auth: 'oauth' }), h1.deps),
      runAddHttp('acme', httpOpts('https://acme.test/mcp', { auth: 'oauth' }), h2.deps),
    ]);

    // Exactly one registration succeeds; the other reports the duplicate.
    expect([c1, c2].filter((c) => c === 0)).toHaveLength(1);
    // Only the winner ran a browser login; the loser bailed before it.
    const loginCalls =
      vi.mocked(h1.deps.runOAuthLogin).mock.calls.length +
      vi.mocked(h2.deps.runOAuthLogin).mock.calls.length;
    expect(loginCalls).toBe(1);
    // The stored token corresponds to the winner that actually logged in — never
    // a loser's token clobbering it.
    const winnerRecord =
      vi.mocked(h1.deps.runOAuthLogin).mock.calls.length === 1 ? recordA : recordB;
    expect(await store.read('acme')).toEqual(winnerRecord);
    const config = await loadConfig(target);
    expect(config.servers.acme).toMatchObject({ auth: { type: 'oauth' } });
  });

  it('accumulates --header KEY=VALUE entries on the explicit bearer path', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);

    const code = await runAddHttp(
      'svc',
      httpOpts('https://example.com/mcp', {
        auth: 'bearer',
        tokenEnv: 'T',
        header: ['X-Foo=foo', 'X-Bar=bar'],
      }),
      h.deps,
    );

    expect(code).toBe(0);
    const config = await loadConfig(target);
    expect(config.servers.svc).toMatchObject({
      headers: { 'X-Foo': 'foo', 'X-Bar': 'bar' },
    });
  });

  it('rejects malformed --header entries', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);

    const code = await runAddHttp(
      'svc',
      httpOpts('https://example.com/mcp', { auth: 'none', header: ['no-equals'] }),
      h.deps,
    );

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('--header');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });
});

describe('runAddHttp — discovery mode (no --auth flag)', () => {
  it('rejects an invalid server name before probing or running OAuth', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'none' }));

    const code = await runAddHttp('Bad Name!', httpOpts('https://svc.example.com/mcp'), h.deps);

    expect(code).toBe(1);
    // An invalid name must not trigger a network probe or browser OAuth flow.
    expect(h.deps.probeAuth).not.toHaveBeenCalled();
    expect(h.deps.runOAuthLogin).not.toHaveBeenCalled();
    expect(h.stderr.value).toContain('Bad Name!');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('rejects a name matching a custom-tool namespace before probing or OAuth', async () => {
    const target = await makeTempConfig();
    await seedToolNamespace(target, 'personal');
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'none' }));

    const code = await runAddHttp('personal', httpOpts('https://svc.example.com/mcp'), h.deps);

    expect(code).toBe(1);
    expect(h.deps.probeAuth).not.toHaveBeenCalled();
    expect(h.deps.runOAuthLogin).not.toHaveBeenCalled();
    expect(h.stderr.value).toContain('collides with the namespace of an imported custom tool');
    const config = await loadConfig(target);
    expect(config.servers.personal).toBeUndefined();
  });

  it('rejects when a colliding tool is imported during the probe (no-auth path)', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);
    // The probe is the window: seed the colliding tool namespace during it.
    h.deps.probeAuth = vi.fn(async (): Promise<AuthHint> => {
      await seedToolNamespace(target, 'personal');
      return { kind: 'none' };
    });

    const code = await runAddHttp('personal', httpOpts('https://svc.example.com/mcp'), h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('collides with the namespace of an imported custom tool');
    const config = await loadConfig(target);
    expect(config.servers.personal).toBeUndefined();
  });

  it('rejects and rolls back the token when a colliding tool is imported during OAuth', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'oauth' }));
    // The browser flow is the window: seed the colliding tool namespace there
    // (and write the token, as a real login would).
    h.deps.runOAuthLogin = vi.fn(
      async (input: RunOAuthLoginInput): Promise<RunOAuthLoginResult> => {
        await seedToolNamespace(target, 'personal');
        await input.tokenStore.write(input.serverName, sampleRecord);
        return { kind: 'success' };
      },
    );

    const code = await runAddHttp('personal', httpOpts('https://svc.example.com/mcp'), h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('collides with the namespace of an imported custom tool');
    const config = await loadConfig(target);
    expect(config.servers.personal).toBeUndefined();
    // The freshly-issued token was rolled back (no prior token existed).
    await expect(h.store.read('personal')).resolves.toBeNull();
  });

  it('probe returns none → writes a no-auth entry, does not run OAuth', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'none' }));

    const code = await runAddHttp('svc', httpOpts('https://svc.example.com/mcp'), h.deps);

    expect(code).toBe(0);
    expect(h.deps.probeAuth).toHaveBeenCalledWith(new URL('https://svc.example.com/mcp'));
    expect(h.deps.runOAuthLogin).not.toHaveBeenCalled();
    const config = await loadConfig(target);
    expect(config.servers.svc).toEqual({
      type: 'http',
      enabled: true,
      url: 'https://svc.example.com/mcp',
      auth: { type: 'none' },
    });
    expect(h.stdout.value).toContain('no auth required');
  });

  it('probe returns oauth → runs login with the resource-metadata URL and writes the oauth entry', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);
    const metaUrl = new URL('https://acme.test/.well-known/oauth-protected-resource/mcp');
    h.deps.probeAuth = vi.fn(() =>
      Promise.resolve<AuthHint>({ kind: 'oauth', resourceMetadataUrl: metaUrl }),
    );
    h.deps.runOAuthLogin = loginSucceeds();

    const code = await runAddHttp('acme', httpOpts('https://acme.test/mcp'), h.deps);

    expect(code).toBe(0);
    expect(h.deps.runOAuthLogin).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'acme', resourceMetadataUrl: metaUrl }),
    );
    const config = await loadConfig(target);
    expect(config.servers.acme).toEqual({
      type: 'http',
      enabled: true,
      url: 'https://acme.test/mcp',
      auth: { type: 'oauth' },
    });
    expect(await h.store.read('acme')).toEqual(sampleRecord);
    expect(h.stdout.value).toContain('OAuth required');
    expect(h.stdout.value).toContain('registered (OAuth)');
  });

  it('probe returns bearer → prints the retry hint and writes nothing (exit 1)', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'bearer' }));

    const code = await runAddHttp('svc', httpOpts('https://svc.example.com/mcp'), h.deps);

    expect(code).toBe(1);
    expect(h.deps.runOAuthLogin).not.toHaveBeenCalled();
    expect(h.stderr.value).toContain('--auth bearer --token-env');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('probe returns unknown (500) → surfaces the status and body, writes nothing (exit 4)', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() =>
      Promise.resolve<AuthHint>({ kind: 'unknown', status: 500, body: 'boom internal error' }),
    );

    const code = await runAddHttp('svc', httpOpts('https://svc.example.com/mcp'), h.deps);

    expect(code).toBe(4);
    expect(h.deps.runOAuthLogin).not.toHaveBeenCalled();
    expect(h.stderr.value).toContain('500');
    expect(h.stderr.value).toContain('boom internal error');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('rejects invalid URLs before probing', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'none' }));

    const code = await runAddHttp('svc', httpOpts('not-a-url'), h.deps);

    expect(code).toBe(1);
    expect(h.deps.probeAuth).not.toHaveBeenCalled();
    expect(h.stderr.value).toContain('not-a-url');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });
});

describe('runAddHttp — OAuth atomicity', () => {
  it('cancelled login writes no config and leaves the token store unchanged (exit 2)', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'oauth' }));
    h.deps.runOAuthLogin = vi.fn(() =>
      Promise.resolve<RunOAuthLoginResult>({ kind: 'cancelled', reason: 'aborted by caller' }),
    );

    const code = await runAddHttp('acme', httpOpts('https://acme.test/mcp'), h.deps);

    expect(code).toBe(2);
    expect(h.stderr.value).toContain('cancelled');
    expect(h.stderr.value).toContain('was not registered');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
    expect(await h.store.read('acme')).toBeNull();
  });

  it('failed login writes no config and leaves the token store unchanged (exit 4)', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'oauth' }));
    h.deps.runOAuthLogin = vi.fn(() =>
      Promise.resolve<RunOAuthLoginResult>({ kind: 'failed', reason: 'discovery exploded' }),
    );

    const code = await runAddHttp('acme', httpOpts('https://acme.test/mcp'), h.deps);

    expect(code).toBe(4);
    expect(h.stderr.value).toContain('discovery exploded');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
    expect(await h.store.read('acme')).toBeNull();
  });

  it('exits 3 without starting the flow when token storage is unavailable', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const store = new InMemoryTokenStore();
    vi.spyOn(store, 'probe').mockResolvedValue({ kind: 'unavailable', reason: 'keychain locked' });
    const h = makeHarness(target, store);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'oauth' }));
    h.deps.runOAuthLogin = loginSucceeds();

    const code = await runAddHttp('acme', httpOpts('https://acme.test/mcp'), h.deps);

    expect(code).toBe(3);
    expect(h.stderr.value).toContain('keychain locked');
    expect(h.deps.runOAuthLogin).not.toHaveBeenCalled();
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('exits non-zero without starting the flow when the prior-token read throws', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const store = new InMemoryTokenStore();
    // probe() is ready, but reading the snapshot throws (corrupt/incompatible record).
    vi.spyOn(store, 'read').mockRejectedValue(new Error('corrupt record'));
    const h = makeHarness(target, store);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'oauth' }));
    h.deps.runOAuthLogin = loginSucceeds();

    const code = await runAddHttp('acme', httpOpts('https://acme.test/mcp'), h.deps);

    expect(code).not.toBe(0);
    expect(h.deps.runOAuthLogin).not.toHaveBeenCalled();
    expect(h.stderr.value).toContain('corrupt record');
    expect(h.stderr.value).toContain('acme');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('rolls back to no token when the config write fails and no prior token existed', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'oauth' }));
    h.deps.runOAuthLogin = loginSucceeds();
    // Login succeeds (the token is written), then the config save throws.
    h.deps.saveConfig = vi.fn(() => Promise.reject(new Error('disk full')));

    const code = await runAddHttp('acme', httpOpts('https://acme.test/mcp'), h.deps);

    expect(code).not.toBe(0);
    expect(h.deps.runOAuthLogin).toHaveBeenCalledTimes(1);
    // The freshly-written token must be deleted on rollback.
    expect(await h.store.read('acme')).toBeNull();
    expect(h.stderr.value).toContain('disk full');
    expect(h.stderr.value).toContain('was not registered');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('does not crash and points at logout when rollback itself fails after a write failure', async () => {
    const target = await makeTempConfig();
    const store = new InMemoryTokenStore();
    // The rollback delete fails too (e.g. the keychain became unavailable).
    vi.spyOn(store, 'delete').mockRejectedValue(new Error('keychain locked'));
    const h = makeHarness(target, store);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'oauth' }));
    h.deps.runOAuthLogin = loginSucceeds();
    h.deps.saveConfig = vi.fn(() => Promise.reject(new Error('disk full')));

    const code = await runAddHttp('acme', httpOpts('https://acme.test/mcp'), h.deps);

    expect(code).not.toBe(0);
    expect(h.stderr.value).toContain('disk full');
    // The user must be told the orphaned token needs manual cleanup.
    expect(h.stderr.value).toContain('tlbx auth logout acme');
  });

  it('restores the prior token when the config write fails and a token already existed', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const store = new InMemoryTokenStore();
    await store.write('acme', priorRecord);
    const h = makeHarness(target, store);
    h.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'oauth' }));
    h.deps.runOAuthLogin = loginSucceeds();
    h.deps.saveConfig = vi.fn(() => Promise.reject(new Error('disk full')));

    const code = await runAddHttp('acme', httpOpts('https://acme.test/mcp'), h.deps);

    expect(code).not.toBe(0);
    expect(h.deps.runOAuthLogin).toHaveBeenCalledTimes(1);
    // Rollback must restore the prior record, not leave the just-written one.
    expect(await h.store.read('acme')).toEqual(priorRecord);
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });
});

describe('duplicate server names', () => {
  it('refuses to overwrite an existing server entry before probing', async () => {
    const target = await makeTempConfig();
    const h1 = makeHarness(target);
    const code1 = await runAddStdio('dup', ['mybin'], stdioOpts(), h1.deps);
    expect(code1).toBe(0);
    const snapshot = await fs.readFile(target, 'utf8');

    const h2 = makeHarness(target);
    h2.deps.probeAuth = vi.fn(() => Promise.resolve<AuthHint>({ kind: 'none' }));
    const code2 = await runAddHttp('dup', httpOpts('https://example.com/mcp'), h2.deps);
    expect(code2).toBe(1);
    expect(h2.stderr.value).toContain('already exists');
    expect(h2.deps.probeAuth).not.toHaveBeenCalled();
    expect(await fs.readFile(target, 'utf8')).toBe(snapshot);
  });
});
