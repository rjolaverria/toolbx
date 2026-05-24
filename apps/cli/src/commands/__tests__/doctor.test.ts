import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG,
  type CachedTool,
  type ServerConfig,
  type StoredOAuthRecord,
  type TokenStore,
  type TokenStoreHealth,
  type ToolBoxConfig,
} from '@toolbox/core';

import {
  checkBindAddress,
  checkConfigValidate,
  checkEnvPlaceholders,
  checkNamespaceCollisions,
  checkNodeVersion,
  checkServerTargets,
  extractBindHost,
  nodeSatisfies,
  runDoctor,
  type DoctorDeps,
} from '../doctor.js';

import { makeTempConfig, type ConfigHarness } from './harness.js';

const harnesses: ConfigHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) {
      await h.cleanup();
    }
  }
});

const STORED_RECORD: StoredOAuthRecord = {
  schemaVersion: 1,
  clientInformation: { client_id: 'cid' },
  tokens: { access_token: 'tok', token_type: 'Bearer' },
  authorizationServer: 'https://auth.test',
  scopes: [],
  obtainedAt: '2026-05-21T00:00:00.000Z',
};

/**
 * Token store seeded by name. `read()` is authoritative (returns a record for
 * seeded names); `list()` enumerates unless `enumerable: false` (simulating a
 * backend without `findCredentials`, which returns `[]`) or `listThrows: true`.
 */
function makeTokenStore(
  opts: {
    names?: readonly string[];
    health?: TokenStoreHealth;
    listThrows?: boolean;
    enumerable?: boolean;
    readThrows?: readonly string[];
  } = {},
): TokenStore & { deleted: string[] } {
  const names = new Set(opts.names ?? []);
  const readThrows = new Set(opts.readThrows ?? []);
  const enumerable = opts.enumerable ?? true;
  const deleted: string[] = [];
  return {
    deleted,
    probe: () => Promise.resolve(opts.health ?? { kind: 'ready' }),
    list: () =>
      opts.listThrows === true
        ? Promise.reject(new Error('enumeration boom'))
        : Promise.resolve(enumerable ? [...names] : []),
    delete: (name) => {
      names.delete(name);
      deleted.push(name);
      return Promise.resolve();
    },
    read: (name) =>
      readThrows.has(name)
        ? Promise.reject(new Error('corrupt entry'))
        : Promise.resolve(names.has(name) ? STORED_RECORD : null),
    write: () => Promise.resolve(),
  };
}

interface Stub {
  env?: Record<string, string | undefined>;
  commands?: Record<string, boolean>;
  defaultCommandExists?: boolean;
  enginesNode?: string | undefined;
  nodeVersion?: string;
  cache?: readonly CachedTool[] | 'missing';
  configSourceOverride?: string | null;
  /** Answer returned by the interactive confirm prompt (defaults to false). */
  confirm?: boolean;
  /** Token store backing the Auth section (defaults to a ready, empty store). */
  tokenStore?: TokenStore & { deleted: string[] };
  /** Host platform reported to remediation hints (defaults to 'darwin'). */
  platform?: NodeJS.Platform;
}

interface Harness {
  deps: DoctorDeps;
  stdout: { value: string };
  stderr: { value: string };
  /** Every prompt string passed to `confirmFix`, in order. */
  confirmPrompts: string[];
  /** The token store wired into `deps.createTokenStore`. */
  store: TokenStore & { deleted: string[] };
}

function makeHarness(target: string, stub: Stub = {}): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const confirmPrompts: string[] = [];
  const store = stub.tokenStore ?? makeTokenStore();
  const deps: DoctorDeps = {
    resolvePath: () => target,
    cwd: () => path.dirname(target),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    getEnv: (name) => stub.env?.[name],
    commandExists: (command) => {
      const declared = stub.commands?.[command];
      if (declared !== undefined) {
        return Promise.resolve(declared);
      }
      return Promise.resolve(stub.defaultCommandExists ?? true);
    },
    readEnginesNode: () => Promise.resolve(stub.enginesNode),
    readToolCacheAt: () => Promise.resolve(stub.cache ?? 'missing'),
    nodeVersion: () => stub.nodeVersion ?? 'v22.5.0',
    readConfigSource: async (resolved) => {
      if (stub.configSourceOverride !== undefined) {
        return stub.configSourceOverride;
      }
      const fs = await import('node:fs/promises');
      try {
        return await fs.readFile(resolved, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    confirmFix: (prompt) => {
      confirmPrompts.push(prompt);
      return Promise.resolve(stub.confirm ?? false);
    },
    createTokenStore: () => store,
    platform: () => stub.platform ?? 'darwin',
  };
  return { deps, stdout, stderr, confirmPrompts, store };
}

function configWith(servers: Record<string, ServerConfig>): ToolBoxConfig {
  return { ...DEFAULT_CONFIG, servers };
}

function configJsonWithHost(host: string): string {
  return JSON.stringify({
    ...DEFAULT_CONFIG,
    server: {
      ...DEFAULT_CONFIG.server,
      http: { ...DEFAULT_CONFIG.server.http, host },
    },
  });
}

describe('nodeSatisfies', () => {
  it('returns true when version meets a `>=major` floor', () => {
    expect(nodeSatisfies('v22.5.0', '>=22')).toBe(true);
  });

  it('returns false when version is below the floor', () => {
    expect(nodeSatisfies('v18.0.0', '>=22')).toBe(false);
  });

  it('handles `>=major.minor.patch`', () => {
    expect(nodeSatisfies('v22.0.0', '>=22.1.0')).toBe(false);
    expect(nodeSatisfies('v22.1.0', '>=22.1.0')).toBe(true);
    expect(nodeSatisfies('v22.1.5', '>=22.1.0')).toBe(true);
  });

  it('returns "unknown" for ranges it cannot parse', () => {
    expect(nodeSatisfies('v22.5.0', '^22')).toBe('unknown');
    expect(nodeSatisfies('v22.5.0', '>= 20 || >=22')).toBe('unknown');
  });
});

describe('checkNodeVersion', () => {
  it('PASS when the version satisfies the range', () => {
    const result = checkNodeVersion('v22.5.0', '>=22');
    expect(result.severity).toBe('PASS');
    expect(result.message).toContain('v22.5.0');
    expect(result.message).toContain('>=22');
  });

  it('WARN when no engines.node is declared', () => {
    const result = checkNodeVersion('v22.5.0', undefined);
    expect(result.severity).toBe('WARN');
    expect(result.message).toContain('no engines.node');
  });

  it('FAIL when below the floor and includes a fix hint', () => {
    const result = checkNodeVersion('v18.0.0', '>=22');
    expect(result.severity).toBe('FAIL');
    expect(result.message).toContain('does not satisfy');
    expect(result.fixHint).toBeDefined();
    expect(result.fixHint).toContain('Node.js');
  });
});

describe('checkConfigValidate', () => {
  it('PASS for a fully-valid config with no issues', () => {
    const result = checkConfigValidate('/cfg', JSON.stringify(DEFAULT_CONFIG), []);
    expect(result.severity).toBe('PASS');
  });

  it('FAIL with a fix hint when source is missing (config not initialized)', () => {
    const result = checkConfigValidate('/cfg', null, []);
    expect(result.severity).toBe('FAIL');
    expect(result.fixHint).toContain('tlbx init');
  });

  it('FAIL when there are schema-level issues', () => {
    const result = checkConfigValidate('/cfg', '{}', [
      { category: 'schema', pointer: '/version', message: 'expected 1' },
    ]);
    expect(result.severity).toBe('FAIL');
    expect(result.fixHint).toContain('tlbx config validate');
    expect(result.details?.[0]).toContain('schema');
  });

  it('PASS when only non-blocking categories are present (e.g. broken-command)', () => {
    const result = checkConfigValidate('/cfg', JSON.stringify(DEFAULT_CONFIG), [
      { category: 'broken-command', pointer: '/servers/x/command', message: 'not on PATH' },
    ]);
    expect(result.severity).toBe('PASS');
  });
});

describe('checkServerTargets', () => {
  it('PASS when there are no enabled servers', () => {
    const cfg = configWith({});
    const result = checkServerTargets(cfg, []);
    expect(result.severity).toBe('PASS');
    expect(result.message).toContain('No enabled servers');
  });

  it('PASS when no broken-command/invalid-url issues are present for enabled servers', () => {
    const cfg = configWith({
      github: { type: 'stdio', enabled: true, command: 'true', args: [] },
    });
    const result = checkServerTargets(cfg, []);
    expect(result.severity).toBe('PASS');
    expect(result.message).toContain('1 enabled');
  });

  it('FAIL with details when an enabled stdio command is broken', () => {
    const cfg = configWith({
      github: { type: 'stdio', enabled: true, command: 'no-such-binary', args: [] },
    });
    const result = checkServerTargets(cfg, [
      {
        category: 'broken-command',
        pointer: '/servers/github/command',
        message: 'command "no-such-binary" was not found on PATH',
      },
    ]);
    expect(result.severity).toBe('FAIL');
    expect(result.fixHint).toContain('tlbx server inspect');
    expect(result.details?.[0]).toContain('broken-command');
  });

  it('PASS when the only broken-command is on a disabled server', () => {
    const cfg = configWith({
      archived: { type: 'stdio', enabled: false, command: 'no-such', args: [] },
      github: { type: 'stdio', enabled: true, command: 'true', args: [] },
    });
    const result = checkServerTargets(cfg, [
      {
        category: 'broken-command',
        pointer: '/servers/archived/command',
        message: 'command "no-such" was not found on PATH',
      },
    ]);
    expect(result.severity).toBe('PASS');
  });

  it('WARN when config could not be loaded', () => {
    const result = checkServerTargets(null, []);
    expect(result.severity).toBe('WARN');
  });
});

describe('checkEnvPlaceholders', () => {
  it('PASS when there are no missing-env issues for enabled servers', () => {
    const cfg = configWith({
      github: { type: 'stdio', enabled: true, command: 'true', args: [] },
    });
    const result = checkEnvPlaceholders(cfg, []);
    expect(result.severity).toBe('PASS');
  });

  it('FAIL when an enabled server references a missing env var', () => {
    const cfg = configWith({
      jira: {
        type: 'http',
        enabled: true,
        url: 'https://jira.example.com/mcp',
        auth: { type: 'bearer', tokenEnv: 'JIRA_TOKEN' },
      },
    });
    const result = checkEnvPlaceholders(cfg, [
      {
        category: 'missing-env',
        pointer: '/servers/jira/auth/tokenEnv',
        message: 'environment variable "JIRA_TOKEN" referenced by auth.tokenEnv is not set',
      },
    ]);
    expect(result.severity).toBe('FAIL');
    expect(result.fixHint).toContain('Export');
    expect(result.details?.[0]).toContain('JIRA_TOKEN');
  });

  it('WARN when config could not be loaded', () => {
    const result = checkEnvPlaceholders(null, []);
    expect(result.severity).toBe('WARN');
  });

  it('PASS when the only missing-env issue is on a disabled server', () => {
    const cfg = configWith({
      archived: {
        type: 'http',
        enabled: false,
        url: 'https://archived.example.com/mcp',
        auth: { type: 'bearer', tokenEnv: 'ARCHIVED_TOKEN' },
      },
    });
    const result = checkEnvPlaceholders(cfg, [
      {
        category: 'missing-env',
        pointer: '/servers/archived/auth/tokenEnv',
        message: 'environment variable "ARCHIVED_TOKEN" is not set',
      },
    ]);
    expect(result.severity).toBe('PASS');
  });
});

describe('checkNamespaceCollisions', () => {
  it('PASS when there are no collisions in cache or config', () => {
    const cfg = configWith({
      github: { type: 'stdio', enabled: true, command: 'true', args: [] },
    });
    const cache: CachedTool[] = [
      {
        exposedName: 'github__create_issue',
        serverName: 'github',
        upstreamName: 'create_issue',
        tool: { name: 'create_issue' },
      },
    ];
    const result = checkNamespaceCollisions(cfg, [], cache);
    expect(result.severity).toBe('PASS');
  });

  it('WARN when no tool cache snapshot exists yet', () => {
    const cfg = configWith({
      github: { type: 'stdio', enabled: true, command: 'true', args: [] },
    });
    const result = checkNamespaceCollisions(cfg, [], 'missing');
    expect(result.severity).toBe('WARN');
    expect(result.message).toContain('tlbx serve');
  });

  it('FAIL when config-level namespace issues are present', () => {
    const cfg = configWith({});
    const result = checkNamespaceCollisions(
      cfg,
      [
        {
          category: 'namespace-collision',
          pointer: '/tools/ghost__do_thing',
          message: 'tool override "ghost__do_thing" references unknown server "ghost"',
        },
      ],
      'missing',
    );
    expect(result.severity).toBe('FAIL');
    expect(result.fixHint).toContain('Rename');
  });

  it('FAIL when two enabled servers expose the same exposed name', () => {
    const cfg = configWith({
      github: { type: 'stdio', enabled: true, command: 'true', args: [] },
    });
    const cache: CachedTool[] = [
      {
        exposedName: 'github__create_issue',
        serverName: 'github',
        upstreamName: 'create_issue',
        tool: { name: 'create_issue' },
      },
      {
        exposedName: 'github__create_issue',
        serverName: 'github',
        upstreamName: 'create_issue',
        tool: { name: 'create_issue' },
      },
    ];
    const result = checkNamespaceCollisions(cfg, [], cache);
    expect(result.severity).toBe('FAIL');
    expect(result.details?.[0]).toContain('github__create_issue');
  });
});

describe('checkBindAddress', () => {
  it('PASS for the default loopback host', () => {
    const result = checkBindAddress('127.0.0.1');
    expect(result.severity).toBe('PASS');
    expect(result.message).toContain('127.0.0.1');
  });

  it('FAIL when the host is not loopback', () => {
    const result = checkBindAddress('0.0.0.0');
    expect(result.severity).toBe('FAIL');
    expect(result.fixHint).toContain('tlbx config set');
  });

  it('WARN when no host could be extracted', () => {
    const result = checkBindAddress(null);
    expect(result.severity).toBe('WARN');
  });
});

describe('extractBindHost', () => {
  it('reads server.http.host from a parsed config object', () => {
    expect(
      extractBindHost({ server: { http: { host: '127.0.0.1', port: 7331, path: '/mcp' } } }),
    ).toBe('127.0.0.1');
  });

  it('reads a non-loopback host even though the schema would reject it', () => {
    // This is the key behaviour: a non-loopback host is a schema error, but
    // doctor still needs to surface it so the dedicated bind-address check
    // can produce a targeted FAIL rather than a generic skip.
    expect(extractBindHost({ server: { http: { host: '0.0.0.0' } } })).toBe('0.0.0.0');
  });

  it('returns null when the shape is missing or malformed', () => {
    expect(extractBindHost(null)).toBeNull();
    expect(extractBindHost({})).toBeNull();
    expect(extractBindHost({ server: null })).toBeNull();
    expect(extractBindHost({ server: { http: null } })).toBeNull();
    expect(extractBindHost({ server: { http: { host: 42 } } })).toBeNull();
  });
});

describe('runDoctor', () => {
  it('returns 0 and prints a summary for a healthy installation', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
      commands: { true: true },
      cache: 'missing',
    });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('[PASS] node-version');
    expect(h.stdout.value).toContain('[PASS] config');
    expect(h.stdout.value).toContain('[PASS] server-targets');
    expect(h.stdout.value).toContain('[PASS] env-placeholders');
    expect(h.stdout.value).toContain('[WARN] namespace-collisions');
    expect(h.stdout.value).toContain('[PASS] bind-address');
    expect(h.stdout.value).toMatch(/6 check\(s\): 5 PASS, 1 WARN, 0 FAIL/);
  });

  it('returns 1 when any check fails and emits fix hints', async () => {
    const cfg = await makeTempConfig(
      configWith({
        broken: { type: 'stdio', enabled: true, command: 'no-such-binary', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v18.0.0',
      commands: { 'no-such-binary': false },
      cache: 'missing',
    });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('[FAIL] node-version');
    expect(h.stdout.value).toContain('[FAIL] server-targets');
    expect(h.stdout.value).toContain('fix: ');
  });

  it('reports a missing config and skips dependent checks with WARN', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const target = path.join(cfg.dir, 'does-not-exist.json');
    const h = makeHarness(target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
    });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('[FAIL] config');
    expect(h.stdout.value).toContain('tlbx init');
    expect(h.stdout.value).toContain('[WARN] server-targets');
    expect(h.stdout.value).toContain('[WARN] env-placeholders');
    expect(h.stdout.value).toContain('[WARN] namespace-collisions');
    expect(h.stdout.value).toContain('[WARN] bind-address');
  });

  it('--json emits a stable, parseable report', async () => {
    const cfg = await makeTempConfig(
      configWith({
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
      commands: { true: true },
      cache: 'missing',
    });

    const code = await runDoctor({ json: true }, h.deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.value) as {
      configPath: string;
      node: string;
      checks: Array<{ id: string; severity: string }>;
      summary: { pass: number; warn: number; fail: number };
      fix: { requested: boolean; applied: string[] };
    };
    expect(parsed.configPath).toBe(cfg.target);
    expect(parsed.node).toBe('v22.5.0');
    expect(parsed.checks.map((c) => c.id)).toEqual([
      'node-version',
      'config',
      'server-targets',
      'env-placeholders',
      'namespace-collisions',
      'bind-address',
    ]);
    expect(parsed.summary.fail).toBe(0);
    expect(parsed.fix).toEqual({ requested: false, applied: [] });
  });

  it('--fix is a no-op when every check passes or warns', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
    });

    const code = await runDoctor({ fix: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('--fix: no failing checks to fix.');
    expect(h.confirmPrompts).toHaveLength(0);
  });

  it('reports a targeted FAIL on bind-address even when the host is schema-invalid', async () => {
    // `0.0.0.0` is rejected by `LoopbackHostSchema`, so the structural
    // `config` check fails. Doctor must still surface a dedicated FAIL on
    // `bind-address` with the `tlbx config set` fix hint instead of just
    // skipping it.
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const fs = await import('node:fs/promises');
    await fs.writeFile(cfg.target, configJsonWithHost('0.0.0.0'), 'utf8');
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
    });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('[FAIL] config');
    expect(h.stdout.value).toContain('[FAIL] bind-address');
    expect(h.stdout.value).toContain('tlbx config set server.http.host');
  });

  it('applies schema defaults so dependent checks do not throw on omitted fields', async () => {
    // A hand-edited config that omits `namespacing.separator` (which has a
    // schema default of `__`) used to bypass schema validation here, so
    // `detectCollisions` would throw on `separator: undefined`. Now we run
    // the schema parse so defaults are applied before downstream checks.
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const fs = await import('node:fs/promises');
    const raw = {
      ...DEFAULT_CONFIG,
      namespacing: { format: 'server__tool', collisionStrategy: 'error' },
      servers: {
        github: { type: 'stdio', enabled: true, command: 'true', args: [] },
      },
    };
    await fs.writeFile(cfg.target, JSON.stringify(raw), 'utf8');
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
      commands: { true: true },
      cache: [
        {
          exposedName: 'github__create_issue',
          serverName: 'github',
          upstreamName: 'create_issue',
          tool: { name: 'create_issue' },
        },
      ],
    });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('[PASS] namespace-collisions');
  });

  it('--fix in --json mode records fix.requested=true and fix.applied=[]', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
    });

    const code = await runDoctor({ fix: true, json: true }, h.deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.value) as {
      fix: { requested: boolean; applied: string[] };
    };
    expect(parsed.fix).toEqual({ requested: true, applied: [] });
  });
});

describe('runDoctor --fix fixers', () => {
  async function readJson(filePath: string): Promise<unknown> {
    const fs = await import('node:fs/promises');
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  }

  async function pathMissing(filePath: string): Promise<boolean> {
    const fs = await import('node:fs/promises');
    try {
      await fs.stat(filePath);
      return false;
    } catch {
      return true;
    }
  }

  it('--fix --yes creates a missing config directory and writes the default config', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const target = path.join(cfg.dir, 'nested', 'config.json');
    const h = makeHarness(target, { enginesNode: '>=22', nodeVersion: 'v22.5.0' });

    const code = await runDoctor({ fix: true, yes: true }, h.deps);

    // The config check was FAIL when observed, so the run still exits non-zero;
    // the fix only takes effect on a subsequent invocation.
    expect(code).toBe(1);
    expect(h.stdout.value).toContain('--fix: created config directory');
    expect(h.stdout.value).toContain('[APPLIED]');
    expect(h.confirmPrompts).toHaveLength(0);
    expect(await readJson(target)).toEqual(DEFAULT_CONFIG);

    const rerun = makeHarness(target, { enginesNode: '>=22', nodeVersion: 'v22.5.0' });
    const code2 = await runDoctor({}, rerun.deps);
    expect(code2).toBe(0);
    expect(rerun.stdout.value).toContain('[PASS] config');
  });

  it('--fix --yes writes the default config when the directory already exists', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const target = path.join(cfg.dir, 'other.json');
    const h = makeHarness(target, { enginesNode: '>=22', nodeVersion: 'v22.5.0' });

    const code = await runDoctor({ fix: true, yes: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toMatch(/--fix: wrote a default config to .*other\.json \[APPLIED\]/);
    expect(await readJson(target)).toEqual(DEFAULT_CONFIG);
  });

  it('--fix prompts and applies the config fix when the prompt is accepted', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const target = path.join(cfg.dir, 'yes-path', 'config.json');
    const h = makeHarness(target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
      confirm: true,
    });

    const code = await runDoctor({ fix: true }, h.deps);

    expect(code).toBe(1);
    expect(h.confirmPrompts).toHaveLength(1);
    expect(h.stdout.value).toContain('[APPLIED]');
    expect(await readJson(target)).toEqual(DEFAULT_CONFIG);
  });

  it('--fix leaves the config alone when the prompt is declined', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const target = path.join(cfg.dir, 'declined', 'config.json');
    const h = makeHarness(target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
      confirm: false,
    });

    const code = await runDoctor({ fix: true }, h.deps);

    expect(code).toBe(1);
    expect(h.confirmPrompts).toHaveLength(1);
    expect(h.stdout.value).toContain('SKIPPED (declined)');
    expect(await pathMissing(target)).toBe(true);
    expect(await pathMissing(path.dirname(target))).toBe(true);
  });

  it('--fix reports no available fix when the config parent is not a directory', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const fs = await import('node:fs/promises');
    const blocker = path.join(cfg.dir, 'blocker');
    await fs.writeFile(blocker, 'not a directory', 'utf8');
    const target = path.join(blocker, 'config.json');
    const h = makeHarness(target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
      // Simulate a missing config file so the config fixer is reached; the
      // parent path resolves to an existing *file*, which the fixer must
      // refuse to clobber.
      configSourceOverride: null,
      confirm: true,
    });

    const code = await runDoctor({ fix: true, yes: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('[FAIL] config');
    expect(h.stdout.value).toContain('SKIPPED (no fix available): ');
    expect(h.stdout.value).toContain('is not a directory');
    expect(h.confirmPrompts).toHaveLength(0);
    expect(await pathMissing(target)).toBe(true);
  });

  it('--fix reports no available fix for a structurally broken config', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const fs = await import('node:fs/promises');
    await fs.writeFile(cfg.target, '{ not valid json', 'utf8');
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
      confirm: true,
    });

    const code = await runDoctor({ fix: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('[FAIL] config');
    expect(h.stdout.value).toContain('SKIPPED (no fix available)');
    expect(h.confirmPrompts).toHaveLength(0);
  });

  it('--fix reports no available fix for a FAIL check without a fixer', async () => {
    const cfg = await makeTempConfig(
      configWith({
        broken: { type: 'stdio', enabled: true, command: 'no-such-binary', args: [] },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
      commands: { 'no-such-binary': false },
      cache: 'missing',
    });

    const code = await runDoctor({ fix: true, yes: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('[FAIL] server-targets');
    expect(h.stdout.value).toContain('SKIPPED (no fix available)');
  });

  it('--fix --yes prints an export snippet for missing env vars but stays FAIL', async () => {
    const cfg = await makeTempConfig(
      configWith({
        jira: {
          type: 'http',
          enabled: true,
          url: 'https://jira.example.com/mcp',
          auth: { type: 'bearer', tokenEnv: 'JIRA_TOKEN' },
        },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
      env: {},
      cache: 'missing',
    });

    const code = await runDoctor({ fix: true, yes: true }, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('[FAIL] env-placeholders');
    expect(h.stdout.value).toContain('export JIRA_TOKEN=...');
    expect(h.stdout.value).toContain('[APPLIED]');
  });

  it('--fix does not print the env snippet when the prompt is declined', async () => {
    const cfg = await makeTempConfig(
      configWith({
        jira: {
          type: 'http',
          enabled: true,
          url: 'https://jira.example.com/mcp',
          auth: { type: 'bearer', tokenEnv: 'JIRA_TOKEN' },
        },
      }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
      env: {},
      cache: 'missing',
      confirm: false,
    });

    const code = await runDoctor({ fix: true }, h.deps);

    expect(code).toBe(1);
    expect(h.confirmPrompts).toHaveLength(1);
    expect(h.stdout.value).toContain('SKIPPED (declined)');
    expect(h.stdout.value).not.toContain('export JIRA_TOKEN');
  });

  it('--fix --yes --json records the per-check fix outcome', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const target = path.join(cfg.dir, 'fresh', 'config.json');
    const h = makeHarness(target, { enginesNode: '>=22', nodeVersion: 'v22.5.0' });

    const code = await runDoctor({ fix: true, yes: true, json: true }, h.deps);

    expect(code).toBe(1);
    const parsed = JSON.parse(h.stdout.value) as {
      checks: Array<{
        id: string;
        fix: { status: string; summary: string; lines: string[] } | null;
      }>;
      fix: { requested: boolean; applied: string[] };
    };
    const configCheck = parsed.checks.find((c) => c.id === 'config');
    expect(configCheck?.fix?.status).toBe('APPLIED');
    expect(parsed.fix).toEqual({ requested: true, applied: ['config'] });
    const nodeCheck = parsed.checks.find((c) => c.id === 'node-version');
    expect(nodeCheck?.fix).toBeNull();
  });

  it('--fix --json without --yes declines without prompting', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const target = path.join(cfg.dir, 'json-no-yes', 'config.json');
    const h = makeHarness(target, { enginesNode: '>=22', nodeVersion: 'v22.5.0' });

    const code = await runDoctor({ fix: true, json: true }, h.deps);

    expect(code).toBe(1);
    expect(h.confirmPrompts).toHaveLength(0);
    const parsed = JSON.parse(h.stdout.value) as {
      checks: Array<{ id: string; fix: { status: string } | null }>;
      fix: { requested: boolean; applied: string[] };
    };
    expect(parsed.checks.find((c) => c.id === 'config')?.fix?.status).toBe('SKIPPED_DECLINED');
    expect(parsed.fix).toEqual({ requested: true, applied: [] });
    expect(await pathMissing(target)).toBe(true);
  });

  it('running --fix --yes twice is idempotent', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const target = path.join(cfg.dir, 'idem', 'config.json');

    const first = makeHarness(target, { enginesNode: '>=22', nodeVersion: 'v22.5.0' });
    await runDoctor({ fix: true, yes: true }, first.deps);
    const fs = await import('node:fs/promises');
    const afterFirst = await fs.readFile(target, 'utf8');

    const second = makeHarness(target, { enginesNode: '>=22', nodeVersion: 'v22.5.0' });
    const code2 = await runDoctor({ fix: true, yes: true }, second.deps);
    const afterSecond = await fs.readFile(target, 'utf8');

    expect(afterSecond).toBe(afterFirst);
    expect(code2).toBe(0);
    expect(second.stdout.value).toContain('--fix: no failing checks to fix.');
  });
});

describe('runDoctor auth section', () => {
  function oauthConfig(names: readonly string[]): ToolBoxConfig {
    const servers: Record<string, ServerConfig> = {};
    for (const name of names) {
      servers[name] = {
        type: 'http',
        enabled: true,
        url: `https://${name}.test/mcp`,
        auth: { type: 'oauth' },
      };
    }
    return configWith(servers);
  }

  const healthy = { enginesNode: '>=22', nodeVersion: 'v22.5.0' } as const;

  it('omits the section when no OAuth is configured and the store is empty', async () => {
    const cfg = await makeTempConfig(
      configWith({ github: { type: 'stdio', enabled: true, command: 'true', args: [] } }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, { ...healthy, commands: { true: true } });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).not.toContain('auth-store');
    expect(h.stdout.value).toMatch(/6 check\(s\):/);
  });

  it('passes with a green token-store row when there is no drift', async () => {
    const cfg = await makeTempConfig(oauthConfig(['acme']));
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      ...healthy,
      tokenStore: makeTokenStore({ names: ['acme'] }),
    });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('[PASS] auth-store: Token store (keychain) is available');
    expect(h.stdout.value).not.toContain('auth-orphan');
    expect(h.stdout.value).not.toContain('auth-missing');
  });

  it('reports an unavailable store and suppresses drift with a platform hint', async () => {
    const cfg = await makeTempConfig(oauthConfig(['acme']));
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      ...healthy,
      platform: 'linux',
      tokenStore: makeTokenStore({ health: { kind: 'unavailable', reason: 'no secret service' } }),
    });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(1);
    expect(h.stdout.value).toContain('[FAIL] auth-store');
    expect(h.stdout.value).toContain('no secret service');
    expect(h.stdout.value).toContain('gnome-keyring');
    // Drift rows are suppressed: list() is never consulted when the store is down.
    expect(h.stdout.value).not.toContain('auth-missing');
  });

  it('flags an orphan token, then --fix prunes it and a rerun is clean', async () => {
    const cfg = await makeTempConfig(oauthConfig(['acme']));
    harnesses.push(cfg);
    const store = makeTokenStore({ names: ['acme', 'ghost'] });
    const first = makeHarness(cfg.target, { ...healthy, tokenStore: store });

    const code1 = await runDoctor({}, first.deps);

    expect(code1).toBe(0);
    expect(first.stdout.value).toContain('[WARN] auth-orphan:ghost');
    expect(first.stdout.value).toContain('server entry not in config');

    const fixHarness = makeHarness(cfg.target, { ...healthy, tokenStore: store });
    await runDoctor({ fix: true, yes: true }, fixHarness.deps);

    expect(store.deleted).toEqual(['ghost']);
    expect(fixHarness.stdout.value).toContain('deleted orphan token for "ghost" [APPLIED]');

    const rerun = makeHarness(cfg.target, { ...healthy, tokenStore: store });
    await runDoctor({}, rerun.deps);

    expect(rerun.stdout.value).not.toContain('auth-orphan');
  });

  it('does not prune an orphan token when the fix is declined', async () => {
    const cfg = await makeTempConfig(oauthConfig(['acme']));
    harnesses.push(cfg);
    const store = makeTokenStore({ names: ['acme', 'ghost'] });
    const h = makeHarness(cfg.target, { ...healthy, tokenStore: store, confirm: false });

    await runDoctor({ fix: true }, h.deps);

    expect(store.deleted).toEqual([]);
    expect(h.stdout.value).toContain('--fix: SKIPPED (declined)');
  });

  it('reports a missing token without deleting the config entry, even under --fix', async () => {
    const cfg = await makeTempConfig(oauthConfig(['acme']));
    harnesses.push(cfg);
    const store = makeTokenStore({ names: [] });
    const h = makeHarness(cfg.target, { ...healthy, tokenStore: store });

    const code = await runDoctor({ fix: true, yes: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('[WARN] auth-missing:acme');
    expect(h.stdout.value).toContain('run `tlbx auth login acme`');
    // No browser flow and no config mutation: the entry survives and nothing is deleted.
    expect(store.deleted).toEqual([]);
    const fs = await import('node:fs/promises');
    const onDisk = JSON.parse(await fs.readFile(cfg.target, 'utf8')) as ToolBoxConfig;
    expect(onDisk.servers.acme).toBeDefined();

    const rerun = makeHarness(cfg.target, { ...healthy, tokenStore: store });
    await runDoctor({}, rerun.deps);
    expect(rerun.stdout.value).toContain('[WARN] auth-missing:acme');
  });

  it('stays silent when list() throws and no OAuth is configured', async () => {
    const cfg = await makeTempConfig(
      configWith({ github: { type: 'stdio', enabled: true, command: 'true', args: [] } }),
    );
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      ...healthy,
      commands: { true: true },
      tokenStore: makeTokenStore({ listThrows: true }),
    });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).not.toContain('auth-store');
    expect(h.stdout.value).toMatch(/6 check\(s\):/);
  });

  it('does not report missing when enumeration is unsupported but read() finds the token', async () => {
    const cfg = await makeTempConfig(oauthConfig(['acme']));
    harnesses.push(cfg);
    // `enumerable: false` mimics a keychain backend without findCredentials:
    // list() returns [] even though 'acme' has a valid stored record.
    const h = makeHarness(cfg.target, {
      ...healthy,
      tokenStore: makeTokenStore({ names: ['acme'], enumerable: false }),
    });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('[PASS] auth-store');
    expect(h.stdout.value).not.toContain('auth-missing');
    expect(h.stdout.value).not.toContain('auth-orphan');
  });

  it('treats an unreadable (corrupt) entry as present, not missing', async () => {
    const cfg = await makeTempConfig(oauthConfig(['acme']));
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      ...healthy,
      tokenStore: makeTokenStore({ names: ['acme'], readThrows: ['acme'] }),
    });

    const code = await runDoctor({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('[PASS] auth-store');
    expect(h.stdout.value).not.toContain('auth-missing');
  });
});
