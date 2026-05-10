import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG,
  type CachedTool,
  type ServerConfig,
  type ToolBoxConfig,
} from '@toolbox/core';

import {
  checkBindAddress,
  checkConfigValidate,
  checkEnvPlaceholders,
  checkNamespaceCollisions,
  checkNodeVersion,
  checkServerTargets,
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

interface Stub {
  env?: Record<string, string | undefined>;
  commands?: Record<string, boolean>;
  defaultCommandExists?: boolean;
  enginesNode?: string | undefined;
  nodeVersion?: string;
  cache?: readonly CachedTool[] | 'missing';
  configSourceOverride?: string | null;
}

interface Harness {
  deps: DoctorDeps;
  stdout: { value: string };
  stderr: { value: string };
}

function makeHarness(target: string, stub: Stub = {}): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
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
  };
  return { deps, stdout, stderr };
}

function configWith(servers: Record<string, ServerConfig>): ToolBoxConfig {
  return { ...DEFAULT_CONFIG, servers };
}

function withHost(host: string): ToolBoxConfig {
  return {
    ...DEFAULT_CONFIG,
    server: {
      ...DEFAULT_CONFIG.server,
      http: { ...DEFAULT_CONFIG.server.http, host },
    },
  };
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
    const result = checkBindAddress(DEFAULT_CONFIG);
    expect(result.severity).toBe('PASS');
    expect(result.message).toContain('127.0.0.1');
  });

  it('FAIL when the host is not loopback', () => {
    const result = checkBindAddress(withHost('0.0.0.0'));
    expect(result.severity).toBe('FAIL');
    expect(result.fixHint).toContain('tlbx config set');
  });

  it('WARN when config could not be loaded', () => {
    const result = checkBindAddress(null);
    expect(result.severity).toBe('WARN');
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

  it('--fix reports that no automatic fixes were applied (Phase 1 stub)', async () => {
    const cfg = await makeTempConfig();
    harnesses.push(cfg);
    const h = makeHarness(cfg.target, {
      enginesNode: '>=22',
      nodeVersion: 'v22.5.0',
    });

    const code = await runDoctor({ fix: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('--fix');
    expect(h.stdout.value).toContain('no automatic fixes');
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
