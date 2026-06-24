import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type ToolBoxConfig } from '@rjolaverria/toolbox-core';

import {
  collectIssues,
  runConfigValidate,
  type ConfigValidateDeps,
  type ValidationIssue,
} from '../config-validate.js';

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
}

interface Harness {
  deps: ConfigValidateDeps;
  stdout: { value: string };
  stderr: { value: string };
}

function makeHarness(target: string, stub: Stub = {}): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const deps: ConfigValidateDeps = {
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
  };
  return { deps, stdout, stderr };
}

function findIssue(
  issues: readonly ValidationIssue[],
  predicate: (i: ValidationIssue) => boolean,
): ValidationIssue | undefined {
  return issues.find(predicate);
}

async function writeRaw(target: string, content: string): Promise<void> {
  await fs.writeFile(target, content, 'utf8');
}

describe('collectIssues', () => {
  it('returns no issues for a valid default config', async () => {
    const issues = await collectIssues(JSON.stringify(DEFAULT_CONFIG, null, 2), {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: () => Promise.resolve(true),
    });
    expect(issues).toEqual([]);
  });

  it('flags broken stdio commands', async () => {
    const cfg: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      servers: {
        ghost: { type: 'stdio', enabled: true, command: 'definitely-not-on-path-xyz', args: [] },
      },
    };
    const issues = await collectIssues(JSON.stringify(cfg), {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: (command) => Promise.resolve(command !== 'definitely-not-on-path-xyz'),
    });
    const found = findIssue(issues, (i) => i.category === 'broken-command');
    expect(found?.pointer).toBe('/servers/ghost/command');
    expect(found?.message).toContain('definitely-not-on-path-xyz');
  });

  it('flags duplicate JSON server keys as duplicate-name', async () => {
    const raw = `{
      "version": 1,
      "server": ${JSON.stringify(DEFAULT_CONFIG.server)},
      "progressiveDisclosure": ${JSON.stringify(DEFAULT_CONFIG.progressiveDisclosure)},
      "namespacing": ${JSON.stringify(DEFAULT_CONFIG.namespacing)},
      "servers": {
        "github": { "type": "stdio", "enabled": true, "command": "true", "args": [] },
        "github": { "type": "stdio", "enabled": false, "command": "true", "args": [] }
      },
      "tools": {}
    }`;
    const issues = await collectIssues(raw, {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: () => Promise.resolve(true),
    });
    const found = findIssue(issues, (i) => i.category === 'duplicate-name');
    expect(found?.pointer).toBe('/servers/github');
  });

  it('flags invalid URLs', async () => {
    const cfg: unknown = {
      ...DEFAULT_CONFIG,
      servers: {
        jira: { type: 'http', enabled: true, url: 'not-a-url' },
      },
    };
    const issues = await collectIssues(JSON.stringify(cfg), {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: () => Promise.resolve(true),
    });
    const found = findIssue(issues, (i) => i.category === 'invalid-url');
    expect(found?.pointer).toBe('/servers/jira/url');
  });

  it('flags missing env vars in auth.tokenEnv', async () => {
    const cfg: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      servers: {
        jira: {
          type: 'http',
          enabled: true,
          url: 'https://jira.example.com/mcp',
          auth: { type: 'bearer', tokenEnv: 'JIRA_TOKEN_ABSENT' },
        },
      },
    };
    const issues = await collectIssues(JSON.stringify(cfg), {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: (name) => (name === 'JIRA_TOKEN_ABSENT' ? undefined : 'x'),
      commandExists: () => Promise.resolve(true),
    });
    const found = findIssue(issues, (i) => i.category === 'missing-env');
    expect(found?.pointer).toBe('/servers/jira/auth/tokenEnv');
    expect(found?.message).toContain('JIRA_TOKEN_ABSENT');
  });

  it('flags missing ${env:NAME} placeholders inside stdio env values', async () => {
    const cfg: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      servers: {
        github: {
          type: 'stdio',
          enabled: true,
          command: 'true',
          args: [],
          env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN_ABSENT}' },
        },
      },
    };
    const issues = await collectIssues(JSON.stringify(cfg), {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: () => Promise.resolve(true),
    });
    const found = findIssue(issues, (i) => i.category === 'missing-env');
    expect(found?.pointer).toBe('/servers/github/env/GITHUB_TOKEN');
    expect(found?.message).toContain('GITHUB_TOKEN_ABSENT');
  });

  it('flags namespace collisions when a server name contains __', async () => {
    const raw = JSON.stringify({
      ...DEFAULT_CONFIG,
      servers: {
        bad__name: { type: 'stdio', enabled: true, command: 'true', args: [] },
      },
    });
    const issues = await collectIssues(raw, {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: () => Promise.resolve(true),
    });
    const found = findIssue(issues, (i) => i.category === 'namespace-collision');
    expect(found).toBeDefined();
  });

  it('flags tool overrides that reference unknown servers', async () => {
    const cfg: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      servers: {},
      tools: { ghost__do_thing: { enabled: false } },
    };
    const issues = await collectIssues(JSON.stringify(cfg), {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: () => Promise.resolve(true),
    });
    const found = findIssue(
      issues,
      (i) => i.category === 'namespace-collision' && i.pointer.startsWith('/tools/'),
    );
    expect(found).toBeDefined();
    expect(found?.message).toContain('ghost');
  });

  it('reports a JSON parse error when the file is not JSON', async () => {
    const issues = await collectIssues('not json {', {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: () => Promise.resolve(true),
    });
    expect(issues.some((i) => i.category === 'json')).toBe(true);
  });

  it('passes the server cwd to commandExists for path-like commands', async () => {
    const cfg: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      servers: {
        local: {
          type: 'stdio',
          enabled: true,
          command: './bin/mcp',
          args: [],
          cwd: '/opt/app',
        },
      },
    };
    const seen: Array<{ command: string; cwd: string | undefined }> = [];
    const issues = await collectIssues(JSON.stringify(cfg), {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: (command, cwd) => {
        seen.push({ command, cwd });
        return Promise.resolve(true);
      },
    });
    expect(issues.find((i) => i.category === 'broken-command')).toBeUndefined();
    expect(seen).toEqual([{ command: './bin/mcp', cwd: '/opt/app' }]);
  });

  it('emits RFC 6901 JSON Pointers (escapes ~ and / in segment names)', async () => {
    const cfg: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      servers: {
        jira: {
          type: 'http',
          enabled: true,
          url: 'https://jira.example.com/mcp',
          headers: { 'X/Custom~Header': '${env:MISSING_HDR}' },
        },
      },
    };
    const issues = await collectIssues(JSON.stringify(cfg), {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: () => Promise.resolve(true),
    });
    const found = issues.find((i) => i.category === 'missing-env');
    // `~` -> `~0`, `/` -> `~1`; per RFC 6901 the `~` escape comes first.
    expect(found?.pointer).toBe('/servers/jira/headers/X~1Custom~0Header');
  });

  it('uses an empty pointer string for root-level issues (RFC 6901)', async () => {
    const issues = await collectIssues('not json {', {
      resolvePath: () => '',
      cwd: () => '',
      stdout: () => undefined,
      stderr: () => undefined,
      getEnv: () => undefined,
      commandExists: () => Promise.resolve(true),
    });
    const found = issues.find((i) => i.category === 'json');
    expect(found?.pointer).toBe('');
  });
});

describe('runConfigValidate', () => {
  it('returns 0 and prints a success message for a valid config', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runConfigValidate({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('valid');
  });

  it('returns 1 and prints each issue when the config is invalid', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    await writeRaw(
      cfg.target,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        servers: {
          jira: { type: 'http', enabled: true, url: 'not-a-url' },
        },
      }),
    );
    const h = makeHarness(cfg.target);

    const code = await runConfigValidate({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('invalid-url');
    expect(h.stderr.value).toContain('/servers/jira/url');
  });

  it('emits JSON output with --json', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    await writeRaw(
      cfg.target,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        servers: {
          jira: { type: 'http', enabled: true, url: 'not-a-url' },
        },
      }),
    );
    const h = makeHarness(cfg.target);

    const code = await runConfigValidate({ json: true }, h.deps);

    expect(code).toBe(1);
    const parsed: unknown = JSON.parse(h.stdout.value);
    expect(parsed).toMatchObject({ path: cfg.target });
  });

  it('reports a missing config file', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    await fs.unlink(cfg.target);
    const h = makeHarness(cfg.target);

    const code = await runConfigValidate({}, h.deps);

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('No ToolBox config found');
  });
});
