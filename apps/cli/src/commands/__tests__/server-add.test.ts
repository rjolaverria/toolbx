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

import {
  runAddHttp,
  runAddStdio,
  type AddHttpOptions,
  type AddStdioOptions,
  type ServerAddDeps,
} from '../server-add.js';

const tempDirs: string[] = [];

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
  schemaVersion: 1,
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
