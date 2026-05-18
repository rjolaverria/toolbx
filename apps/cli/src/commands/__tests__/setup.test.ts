import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  loadConfig,
  type ClientAdapter,
  type ClientName,
  type DetectedClient,
  type InstallOpts,
  type InstallResult,
} from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSetupDeps, runSetup, type SetupDeps, type SetupOptions } from '../setup.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix = 'toolbox-cli-setup-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

interface FakeAdapterBehavior {
  name: ClientName;
  configPath: string;
  install?: (opts: InstallOpts) => Promise<InstallResult>;
}

function fakeAdapter(behavior: FakeAdapterBehavior): ClientAdapter {
  return {
    name: behavior.name,
    configPath: behavior.configPath,
    detect: (): Promise<DetectedClient | null> =>
      Promise.resolve({ name: behavior.name, configPath: behavior.configPath }),
    install:
      behavior.install ??
      ((): Promise<InstallResult> =>
        Promise.resolve({
          ok: true,
          status: 'installed',
          configPath: behavior.configPath,
          diff: '+ change',
        })),
  };
}

interface QueuedPrompter {
  prompt: (question: string) => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
  prompts: string[];
  confirms: string[];
}

function queuedPrompter(answers: { text?: string[]; confirm?: boolean[] }): QueuedPrompter {
  const text = [...(answers.text ?? [])];
  const confirms = [...(answers.confirm ?? [])];
  const prompts: string[] = [];
  const confirmQuestions: string[] = [];
  return {
    prompts,
    confirms: confirmQuestions,
    prompt: (question) => {
      prompts.push(question);
      const next = text.shift();
      if (next === undefined) {
        throw new Error(`No queued answer for prompt: ${question}`);
      }
      return Promise.resolve(next);
    },
    confirm: (question) => {
      confirmQuestions.push(question);
      const next = confirms.shift();
      if (next === undefined) {
        throw new Error(`No queued answer for confirm: ${question}`);
      }
      return Promise.resolve(next);
    },
  };
}

interface Harness {
  deps: SetupDeps;
  stdout: { value: string };
  stderr: { value: string };
  configPath: string;
}

interface MakeHarnessOptions {
  configPath?: string;
  detected?: readonly DetectedClient[];
  adapters?: Partial<Record<ClientName, ClientAdapter>>;
  prompter?: QueuedPrompter;
  cwd?: string;
}

function makeHarness(opts: MakeHarnessOptions = {}): Harness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const configPath = opts.configPath ?? path.join(os.tmpdir(), 'toolbox-fake-config.json');
  const detected = opts.detected ?? [];
  const adapters = opts.adapters ?? {};
  const prompter =
    opts.prompter ??
    queuedPrompter({
      text: [],
      confirm: [],
    });
  const deps: SetupDeps = {
    write: (m) => {
      stdout.value += m;
    },
    writeErr: (m) => {
      stderr.value += m;
    },
    prompter,
    resolveConfigPath: () => configPath,
    cwd: () => opts.cwd ?? process.cwd(),
    detectClients: () => Promise.resolve(detected),
    resolveAdapter: (name) => adapters[name] ?? null,
  };
  return { deps, stdout, stderr, configPath };
}

const baseOptions: SetupOptions = {
  yes: false,
  noServer: false,
  clients: undefined,
  transport: undefined,
  config: undefined,
};

describe('runSetup', () => {
  it('rejects --transport http with the unsupported message and writes nothing', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const h = makeHarness({ configPath });

    const code = await runSetup({ ...baseOptions, transport: 'http' }, h.deps);

    expect(code).not.toBe(0);
    expect(h.stderr.value).toMatch(/--transport http is not yet supported/);
    await expect(fs.stat(configPath)).rejects.toThrow();
  });

  it('creates the config on first run and reports the path', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const h = makeHarness({ configPath });

    const code = await runSetup({ ...baseOptions, yes: true, noServer: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/Created.*config/i);
    expect(h.stdout.value).toContain(configPath);
    const loaded = await loadConfig(configPath);
    expect(loaded.version).toBe(1);
  });

  it('reports "config already exists" without modifying the file on a re-run', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, '{ "version": 1, "servers": {} }\n', 'utf8');
    const before = await fs.readFile(configPath, 'utf8');
    const h = makeHarness({ configPath });

    const code = await runSetup({ ...baseOptions, yes: true, noServer: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/already exists/i);
    const after = await fs.readFile(configPath, 'utf8');
    expect(after).toBe(before);
  });

  it('prints a friendly note when no MCP clients are detected', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const h = makeHarness({ configPath, detected: [] });

    const code = await runSetup({ ...baseOptions, yes: true, noServer: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/No MCP clients detected/);
    expect(h.stdout.value).toMatch(/tlbx client install/);
  });

  it('lists detected clients with display names and paths', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const detected: DetectedClient[] = [
      { name: 'claude', configPath: '/fake/home/.claude.json' },
      { name: 'codex', configPath: '/fake/home/.codex/config.toml' },
    ];
    const adapters = {
      claude: fakeAdapter({
        name: 'claude',
        configPath: '/fake/home/.claude.json',
        install: () =>
          Promise.resolve({
            ok: true,
            status: 'installed',
            configPath: '/fake/home/.claude.json',
            diff: '+ mcpServers.toolbox = ...',
          }),
      }),
      codex: fakeAdapter({
        name: 'codex',
        configPath: '/fake/home/.codex/config.toml',
        install: () =>
          Promise.resolve({
            ok: true,
            status: 'installed',
            configPath: '/fake/home/.codex/config.toml',
            diff: '+ [mcp_servers.toolbox]',
          }),
      }),
    };
    const h = makeHarness({ configPath, detected, adapters });

    const code = await runSetup({ ...baseOptions, yes: true, noServer: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/Claude Code/);
    expect(h.stdout.value).toContain('/fake/home/.claude.json');
    expect(h.stdout.value).toMatch(/Codex/);
    expect(h.stdout.value).toContain('/fake/home/.codex/config.toml');
  });

  it('previews diffs and writes both clients when --yes is set', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const claudeCalls: InstallOpts[] = [];
    const codexCalls: InstallOpts[] = [];
    const adapters = {
      claude: fakeAdapter({
        name: 'claude',
        configPath: '/fake/.claude.json',
        install: (opts) => {
          claudeCalls.push(opts);
          return Promise.resolve({
            ok: true,
            status: 'installed',
            configPath: '/fake/.claude.json',
            backupPath: '/fake/.claude.json.bak',
            diff: '+ mcpServers.toolbox = {...}',
          });
        },
      }),
      codex: fakeAdapter({
        name: 'codex',
        configPath: '/fake/.codex/config.toml',
        install: (opts) => {
          codexCalls.push(opts);
          return Promise.resolve({
            ok: true,
            status: 'installed',
            configPath: '/fake/.codex/config.toml',
            backupPath: '/fake/.codex/config.toml.bak',
            diff: '+ [mcp_servers.toolbox]',
          });
        },
      }),
    };
    const detected: DetectedClient[] = [
      { name: 'claude', configPath: '/fake/.claude.json' },
      { name: 'codex', configPath: '/fake/.codex/config.toml' },
    ];
    const h = makeHarness({ configPath, detected, adapters });

    const code = await runSetup({ ...baseOptions, yes: true, noServer: true }, h.deps);

    expect(code).toBe(0);
    expect(claudeCalls).toEqual([
      { dryRun: true, force: false },
      { dryRun: false, force: false },
    ]);
    expect(codexCalls).toEqual([
      { dryRun: true, force: false },
      { dryRun: false, force: false },
    ]);
    expect(h.stdout.value).toMatch(/Restart.*Claude Code.*Codex|Codex.*Claude Code/);
  });

  it('prompts once before applying when --yes is not set', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const installCalls: InstallOpts[] = [];
    const adapters = {
      claude: fakeAdapter({
        name: 'claude',
        configPath: '/fake/.claude.json',
        install: (opts) => {
          installCalls.push(opts);
          return Promise.resolve({
            ok: true,
            status: 'installed',
            configPath: '/fake/.claude.json',
            backupPath: '/fake/.claude.json.bak',
            diff: '+ change',
          });
        },
      }),
    };
    const detected: DetectedClient[] = [{ name: 'claude', configPath: '/fake/.claude.json' }];
    const prompter = queuedPrompter({ confirm: [true] });
    const h = makeHarness({ configPath, detected, adapters, prompter });

    const code = await runSetup({ ...baseOptions, noServer: true }, h.deps);

    expect(code).toBe(0);
    expect(prompter.confirms).toHaveLength(1);
    expect(prompter.confirms[0]).toMatch(/Wire ToolBox into Claude Code/);
    expect(installCalls).toEqual([
      { dryRun: true, force: false },
      { dryRun: false, force: false },
    ]);
  });

  it('skips applying when the user declines the confirmation', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const installCalls: InstallOpts[] = [];
    const adapters = {
      claude: fakeAdapter({
        name: 'claude',
        configPath: '/fake/.claude.json',
        install: (opts) => {
          installCalls.push(opts);
          return Promise.resolve({
            ok: true,
            status: 'installed',
            configPath: '/fake/.claude.json',
            backupPath: '/fake/.claude.json.bak',
            diff: '+ change',
          });
        },
      }),
    };
    const detected: DetectedClient[] = [{ name: 'claude', configPath: '/fake/.claude.json' }];
    const prompter = queuedPrompter({ confirm: [false] });
    const h = makeHarness({ configPath, detected, adapters, prompter });

    const code = await runSetup({ ...baseOptions, noServer: true }, h.deps);

    expect(code).toBe(0);
    expect(installCalls).toEqual([{ dryRun: true, force: false }]);
    expect(h.stdout.value).toMatch(/skipped client install/i);
  });

  it('does not prompt when every detected client is already-installed', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const adapters = {
      claude: fakeAdapter({
        name: 'claude',
        configPath: '/fake/.claude.json',
        install: () =>
          Promise.resolve({
            ok: true,
            status: 'already-installed',
            configPath: '/fake/.claude.json',
            diff: '',
          }),
      }),
    };
    const detected: DetectedClient[] = [{ name: 'claude', configPath: '/fake/.claude.json' }];
    const prompter = queuedPrompter({ confirm: [] });
    const h = makeHarness({ configPath, detected, adapters, prompter });

    const code = await runSetup({ ...baseOptions, noServer: true }, h.deps);

    expect(code).toBe(0);
    expect(prompter.confirms).toHaveLength(0);
    expect(h.stdout.value).toMatch(/already wired/i);
  });

  it('continues on per-client install failure and returns 0 if at least one succeeded', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    let codexCalls = 0;
    const adapters = {
      claude: fakeAdapter({
        name: 'claude',
        configPath: '/fake/.claude.json',
        install: () =>
          Promise.resolve({
            ok: true,
            status: 'installed',
            configPath: '/fake/.claude.json',
            backupPath: '/fake/.claude.json.bak',
            diff: '+ change',
          }),
      }),
      codex: fakeAdapter({
        name: 'codex',
        configPath: '/fake/.codex/config.toml',
        install: () => {
          codexCalls += 1;
          if (codexCalls === 1) {
            return Promise.resolve({
              ok: true,
              status: 'installed',
              configPath: '/fake/.codex/config.toml',
              diff: '+ [mcp_servers.toolbox]',
            });
          }
          return Promise.resolve({
            ok: false,
            reason: 'codex went sideways',
            hint: 'try again',
          });
        },
      }),
    };
    const detected: DetectedClient[] = [
      { name: 'claude', configPath: '/fake/.claude.json' },
      { name: 'codex', configPath: '/fake/.codex/config.toml' },
    ];
    const h = makeHarness({ configPath, detected, adapters });

    const code = await runSetup({ ...baseOptions, yes: true, noServer: true }, h.deps);

    expect(code).toBe(0);
    expect(h.stderr.value).toMatch(/codex went sideways/);
    expect(h.stderr.value).toMatch(/try again/);
  });

  it('returns non-zero when every client install fails', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, '{ "version": 1, "servers": {} }\n', 'utf8');
    const adapters = {
      claude: fakeAdapter({
        name: 'claude',
        configPath: '/fake/.claude.json',
        install: () => Promise.resolve({ ok: false, reason: 'claude broken', hint: 'fix it' }),
      }),
    };
    const detected: DetectedClient[] = [{ name: 'claude', configPath: '/fake/.claude.json' }];
    const h = makeHarness({ configPath, detected, adapters });

    const code = await runSetup({ ...baseOptions, yes: true, noServer: true }, h.deps);

    expect(code).not.toBe(0);
    expect(h.stderr.value).toMatch(/claude broken/);
  });

  it('honors --client to scope installs to a single named client', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const claudeCalls: InstallOpts[] = [];
    const codexCalls: InstallOpts[] = [];
    const adapters = {
      claude: fakeAdapter({
        name: 'claude',
        configPath: '/fake/.claude.json',
        install: (opts) => {
          claudeCalls.push(opts);
          return Promise.resolve({
            ok: true,
            status: 'installed',
            configPath: '/fake/.claude.json',
            diff: '+ change',
          });
        },
      }),
      codex: fakeAdapter({
        name: 'codex',
        configPath: '/fake/.codex/config.toml',
        install: (opts) => {
          codexCalls.push(opts);
          return Promise.resolve({
            ok: true,
            status: 'installed',
            configPath: '/fake/.codex/config.toml',
            diff: '+ [mcp_servers.toolbox]',
          });
        },
      }),
    };
    const detected: DetectedClient[] = [
      { name: 'claude', configPath: '/fake/.claude.json' },
      { name: 'codex', configPath: '/fake/.codex/config.toml' },
    ];
    const h = makeHarness({ configPath, detected, adapters });

    const code = await runSetup(
      { ...baseOptions, yes: true, noServer: true, clients: ['codex'] },
      h.deps,
    );

    expect(code).toBe(0);
    expect(claudeCalls).toEqual([]);
    expect(codexCalls).toEqual([
      { dryRun: true, force: false },
      { dryRun: false, force: false },
    ]);
  });

  it('rejects an unknown client name passed via --client', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const h = makeHarness({ configPath });

    const code = await runSetup(
      { ...baseOptions, yes: true, noServer: true, clients: ['cursor'] },
      h.deps,
    );

    expect(code).not.toBe(0);
    expect(h.stderr.value).toMatch(/cursor/);
    expect(h.stderr.value).toMatch(/claude, codex, opencode/);
  });

  it('skips the server prompt with --no-server and tells the user about server add-stdio', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const prompter = queuedPrompter({ text: [], confirm: [] });
    const h = makeHarness({ configPath, detected: [], prompter });

    const code = await runSetup({ ...baseOptions, yes: true, noServer: true }, h.deps);

    expect(code).toBe(0);
    expect(prompter.prompts).toHaveLength(0);
    expect(h.stdout.value).toMatch(/tlbx server add-stdio/);
  });

  it('with --yes (no --no-server) skips the server prompt but still mentions how to add servers', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const prompter = queuedPrompter({ text: [], confirm: [] });
    const h = makeHarness({ configPath, detected: [], prompter });

    const code = await runSetup({ ...baseOptions, yes: true }, h.deps);

    expect(code).toBe(0);
    expect(prompter.prompts).toHaveLength(0);
    expect(h.stdout.value).toMatch(/tlbx server add-stdio/);
  });

  it('walks the user through adding a stdio server when the interactive prompt accepts', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const prompter = queuedPrompter({
      text: ['jira', 'npx -y @atlassian/jira-mcp', 'JIRA_TOKEN=abc', ''],
      confirm: [true],
    });
    const h = makeHarness({ configPath, detected: [], prompter });

    const code = await runSetup({ ...baseOptions, noServer: false }, h.deps);

    expect(code).toBe(0);
    const loaded = await loadConfig(configPath);
    expect(loaded.servers.jira).toEqual({
      type: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@atlassian/jira-mcp'],
      env: { JIRA_TOKEN: 'abc' },
    });
  });

  it('declines the server prompt cleanly when the user answers "n"', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const prompter = queuedPrompter({
      text: [],
      confirm: [false],
    });
    const h = makeHarness({ configPath, detected: [], prompter });

    const code = await runSetup({ ...baseOptions, noServer: false }, h.deps);

    expect(code).toBe(0);
    const loaded = await loadConfig(configPath);
    expect(loaded.servers).toEqual({});
  });

  it('reprompts for the server name when the entry is invalid', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const prompter = queuedPrompter({
      text: ['bad__name', 'good-name', 'echo hi', ''],
      confirm: [true],
    });
    const h = makeHarness({ configPath, detected: [], prompter });

    const code = await runSetup({ ...baseOptions, noServer: false }, h.deps);

    expect(code).toBe(0);
    expect(h.stderr.value).toMatch(/__/);
    const loaded = await loadConfig(configPath);
    expect(loaded.servers['good-name']).toBeDefined();
  });
});

describe('runSetup integration (real adapters with a temp HOME)', () => {
  it('wires Claude Code and Codex from a clean state and is idempotent', async () => {
    const home = await makeTempDir('toolbox-cli-setup-home-');
    const configPath = path.join(home, 'toolbox-config.json');
    const claudePath = path.join(home, '.claude.json');
    await fs.writeFile(claudePath, '{}\n', 'utf8');
    const codexDir = path.join(home, '.codex');
    await fs.mkdir(codexDir);
    const codexPath = path.join(codexDir, 'config.toml');
    await fs.writeFile(codexPath, '', 'utf8');

    const deps = defaultSetupDeps({
      env: { homedir: () => home, platform: 'darwin', env: {} },
      stdout: () => undefined,
      stderr: () => undefined,
      prompter: queuedPrompter({ text: [], confirm: [] }),
      resolveConfigPath: () => configPath,
    });

    const code = await runSetup({ ...baseOptions, yes: true, noServer: true }, deps);
    expect(code).toBe(0);

    await expect(fs.stat(configPath)).resolves.toBeDefined();
    const claudeText = await fs.readFile(claudePath, 'utf8');
    const claudeParsed = JSON.parse(claudeText) as { mcpServers?: { toolbox?: unknown } };
    expect(claudeParsed.mcpServers?.toolbox).toBeDefined();
    const codexText = await fs.readFile(codexPath, 'utf8');
    expect(codexText).toMatch(/\[mcp_servers\.toolbox\]/);

    const homeEntries = await fs.readdir(home);
    const claudeBackups = homeEntries.filter((f) => f.startsWith('.claude.json.bak'));
    expect(claudeBackups.length).toBe(1);
    const codexEntries = await fs.readdir(codexDir);
    const codexBackups = codexEntries.filter((f) => f.startsWith('config.toml.bak'));
    expect(codexBackups.length).toBe(1);

    const stdout2: string[] = [];
    const deps2 = defaultSetupDeps({
      env: { homedir: () => home, platform: 'darwin', env: {} },
      stdout: (m) => stdout2.push(m),
      stderr: () => undefined,
      prompter: queuedPrompter({ text: [], confirm: [] }),
      resolveConfigPath: () => configPath,
    });
    const code2 = await runSetup({ ...baseOptions, yes: true, noServer: true }, deps2);
    expect(code2).toBe(0);
    expect(stdout2.join('')).toMatch(/already wired/i);
    const homeEntriesAfter = await fs.readdir(home);
    const claudeBackupsAfter = homeEntriesAfter.filter((f) => f.startsWith('.claude.json.bak'));
    expect(claudeBackupsAfter.length).toBe(1);
    const codexEntriesAfter = await fs.readdir(codexDir);
    const codexBackupsAfter = codexEntriesAfter.filter((f) => f.startsWith('config.toml.bak'));
    expect(codexBackupsAfter.length).toBe(1);
  });

  it('returns 0 with the no-clients summary when nothing is detected', async () => {
    const home = await makeTempDir('toolbox-cli-setup-home-');
    const configPath = path.join(home, 'toolbox-config.json');
    const stdout: string[] = [];
    const deps = defaultSetupDeps({
      env: { homedir: () => home, platform: 'darwin', env: {} },
      stdout: (m) => stdout.push(m),
      stderr: () => undefined,
      prompter: queuedPrompter({ text: [], confirm: [] }),
      resolveConfigPath: () => configPath,
    });

    const code = await runSetup({ ...baseOptions, yes: true, noServer: true }, deps);

    expect(code).toBe(0);
    expect(stdout.join('')).toMatch(/No MCP clients detected/);
  });
});

// defaultSetupDeps is exercised lightly here so its shape is locked in; the
// actual interactive prompt path is covered by runSetup tests above.
describe('defaultSetupDeps', () => {
  it('returns a prompter and uses process state when no overrides are passed', () => {
    const deps = defaultSetupDeps();
    expect(typeof deps.prompter.prompt).toBe('function');
    expect(typeof deps.prompter.confirm).toBe('function');
    expect(typeof deps.resolveAdapter('claude')?.install).toBe('function');
    expect(typeof deps.resolveAdapter('codex')?.install).toBe('function');
    expect(typeof deps.resolveAdapter('opencode')?.install).toBe('function');
    expect(typeof deps.resolveConfigPath()).toBe('string');
  });
});
