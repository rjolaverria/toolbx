import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, saveConfig } from '@toolbox/core';

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
  stdout: { value: string };
  stderr: { value: string };
}

function makeHarness(target: string): Harness {
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
  };
  return { deps, stdout, stderr };
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

describe('runAddStdio', () => {
  it('writes the README §4.4 github example entry', async () => {
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
    expect(h.stderr.value).toContain('Invalid Toolbox config');
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

describe('runAddHttp', () => {
  it('writes the README §4.4 jira example entry', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);

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

  it('rejects invalid URLs without modifying the config', async () => {
    const target = await makeTempConfig();
    const before = await fs.readFile(target, 'utf8');
    const h = makeHarness(target);

    const code = await runAddHttp('jira', httpOpts('not-a-url'), h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Invalid Toolbox config');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('accumulates --header KEY=VALUE entries', async () => {
    const target = await makeTempConfig();
    const h = makeHarness(target);

    const code = await runAddHttp(
      'svc',
      httpOpts('https://example.com/mcp', {
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
      httpOpts('https://example.com/mcp', { header: ['no-equals'] }),
      h.deps,
    );

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('--header');
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });
});

describe('duplicate server names', () => {
  it('refuses to overwrite an existing server entry', async () => {
    const target = await makeTempConfig();
    const h1 = makeHarness(target);
    const code1 = await runAddStdio('dup', ['mybin'], stdioOpts(), h1.deps);
    expect(code1).toBe(0);
    const snapshot = await fs.readFile(target, 'utf8');

    const h2 = makeHarness(target);
    const code2 = await runAddHttp('dup', httpOpts('https://example.com/mcp'), h2.deps);
    expect(code2).toBe(1);
    expect(h2.stderr.value).toContain('already exists');
    expect(await fs.readFile(target, 'utf8')).toBe(snapshot);
  });
});
