// Config validation integration test. Drives `tlbx config validate` against
// realistic mistakes a user might commit to disk and asserts every Phase 1
// validation category is caught. Covers SPECS §4.8 acceptance criterion 12:
//
//   "Config validation catches broken commands, duplicate names, invalid
//    URLs, missing environment variables, and namespace collisions."
//
// The namespace-collision case in particular doubles as the explicit
// "two upstream servers produce the same exposed name" assertion called out
// by the M5-06 deliverables — `a_` + tool `search` and `a` + tool `_search`
// both format to `a___search` under the supported `server__tool` /  `__`
// namespacing.

import * as fs from 'node:fs/promises';

import {
  CONFIG_SCHEMA_URL,
  DEFAULT_CONFIG,
  detectCollisions,
  type ToolBoxConfig,
} from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectIssues,
  runConfigValidate,
  type ConfigValidateDeps,
  type IssueCategory,
} from '../../src/commands/config-validate.js';

import { makeTempConfig, type TempConfigHandle } from './helpers.js';

const tempConfigs: TempConfigHandle[] = [];

afterEach(async () => {
  while (tempConfigs.length > 0) {
    const handle = tempConfigs.pop();
    await handle?.cleanup();
  }
});

interface CollectStubs {
  env?: Record<string, string | undefined>;
  commandExists?: (command: string) => boolean;
}

function configValidateDeps(
  target: string,
  stubs: CollectStubs = {},
): {
  deps: ConfigValidateDeps;
  stdout: { value: string };
  stderr: { value: string };
} {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const deps: ConfigValidateDeps = {
    resolvePath: () => target,
    cwd: () => process.cwd(),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    getEnv: (name) => stubs.env?.[name],
    commandExists: (command) => Promise.resolve(stubs.commandExists?.(command) ?? true),
  };
  return { deps, stdout, stderr };
}

function categories(issues: readonly { category: IssueCategory }[]): Set<IssueCategory> {
  return new Set(issues.map((i) => i.category));
}

describe('config validation integration', () => {
  it('flags invalid HTTP URLs at the schema layer', async () => {
    // Schema-rejecting configs short-circuit `collectIssues` after the
    // schema pass, so the `invalid-url` category gets its own dedicated
    // case — the other categories live below where the schema passes.
    const handle = await makeTempConfig(DEFAULT_CONFIG);
    tempConfigs.push(handle);
    const raw = `${JSON.stringify(
      {
        ...DEFAULT_CONFIG,
        servers: {
          remote: { type: 'http', enabled: true, url: 'not-a-url' },
        },
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(handle.target, raw, 'utf8');

    const { deps } = configValidateDeps(handle.target);
    const issues = await collectIssues(raw, deps);
    expect(categories(issues)).toContain('invalid-url');

    const code = await runConfigValidate({ config: handle.target }, deps);
    expect(code).toBe(1);
  });

  it('flags duplicate JSON keys under /servers/ as duplicate-name', async () => {
    // Standard `JSON.stringify` cannot emit duplicate keys, so we hand-format
    // the source. `findDuplicateKeys` parses the raw text before
    // `JSON.parse` collapses the repeats.
    const handle = await makeTempConfig(DEFAULT_CONFIG);
    tempConfigs.push(handle);
    const server = JSON.stringify(DEFAULT_CONFIG.server, null, 2);
    const progressive = JSON.stringify(DEFAULT_CONFIG.progressiveDisclosure, null, 2);
    const namespacing = JSON.stringify(DEFAULT_CONFIG.namespacing, null, 2);
    const raw = `{
  "$schema": ${JSON.stringify(CONFIG_SCHEMA_URL)},
  "version": 1,
  "server": ${server},
  "progressiveDisclosure": ${progressive},
  "namespacing": ${namespacing},
  "servers": {
    "dup": { "type": "stdio", "enabled": true, "command": "node", "args": [] },
    "dup": { "type": "stdio", "enabled": true, "command": "node", "args": [] }
  },
  "tools": {}
}
`;
    await fs.writeFile(handle.target, raw, 'utf8');

    const { deps } = configValidateDeps(handle.target);
    const issues = await collectIssues(raw, deps);
    expect(categories(issues)).toContain('duplicate-name');
  });

  it('flags missing env vars, broken commands, and namespace collisions when the schema passes', async () => {
    // A schema-valid config with three latent problems. `collectIssues`
    // walks past the schema, then runs `checkAuthEnv`, `checkCommand`, and
    // `checkToolOverrides` against each entry — a single config exercises
    // all three categories at once.
    const config: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      servers: {
        remote: {
          type: 'http',
          enabled: true,
          url: 'http://example.com/mcp',
          auth: { type: 'bearer', tokenEnv: 'TOOLBOX_DEF_NOT_SET_DURING_TESTS' },
        },
        local: {
          type: 'stdio',
          enabled: true,
          command: '/definitely/not/a/real/command/toolbox-it',
          args: [],
        },
      },
      tools: {
        // Override referencing an unknown server prefix — flagged as
        // namespace-collision by `checkToolOverrides`.
        'unknown-server__some_tool': { enabled: false },
      },
    };
    const handle = await makeTempConfig(config);
    tempConfigs.push(handle);

    const raw = await fs.readFile(handle.target, 'utf8');
    const { deps } = configValidateDeps(handle.target, {
      env: {},
      commandExists: (command) => !command.includes('not/a/real/command'),
    });
    const issues = await collectIssues(raw, deps);
    const found = categories(issues);
    expect(found).toContain('missing-env');
    expect(found).toContain('broken-command');
    expect(found).toContain('namespace-collision');

    const code = await runConfigValidate({ config: handle.target }, deps);
    expect(code).toBe(1);
  });

  it('detectCollisions surfaces two upstream servers that produce the same exposed name', () => {
    // With the supported `server__tool` format and validated server names
    // (no `__` allowed inside a server name), two distinct upstream servers
    // can still collide whenever their `(serverName, upstreamName)` pairs
    // concatenate to the same string. The smallest example is `a_` + `search`
    // vs. `a` + `_search` → both flatten to `a___search`.
    //
    // This assertion guards the namespace module itself; the runtime relies
    // on it through doctor's `checkNamespaceCollisions` step (M5-05).
    const collisions = detectCollisions(
      {
        a_: ['search'],
        a: ['_search'],
      },
      DEFAULT_CONFIG.namespacing,
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.exposedName).toBe('a___search');
    expect(collisions[0]?.sources).toEqual(
      expect.arrayContaining([
        { serverName: 'a_', upstreamName: 'search' },
        { serverName: 'a', upstreamName: '_search' },
      ]),
    );
  });

  it('runConfigValidate exits clean (0) on a healthy default config', async () => {
    // Sanity guard so the suite isn't one-sided. A healthy config exercises
    // the same code path and must come back green so a regression that
    // breaks the happy path is still caught.
    const config: ToolBoxConfig = {
      ...DEFAULT_CONFIG,
      servers: {
        echo: {
          type: 'stdio',
          enabled: true,
          command: process.execPath,
          args: ['--version'],
        },
      },
    };
    const handle = await makeTempConfig(config);
    tempConfigs.push(handle);

    const { deps } = configValidateDeps(handle.target, {
      env: {},
      commandExists: () => true,
    });
    const code = await runConfigValidate({ config: handle.target }, deps);
    expect(code).toBe(0);
  });
});
