import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createOpencodeAdapter,
  createOpencodeAdapterInternal,
  type InternalInstallHooks,
} from '../opencode.js';
import { TOOLBOX_STDIO_COMMAND } from '../toolbox-command.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
});

async function makeFakeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-opencode-adapter-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeAdapter(home: string, hooks: InternalInstallHooks = {}) {
  return createOpencodeAdapterInternal({ homedir: () => home, platform: 'darwin' }, hooks);
}

async function ensureOpencodeDir(home: string): Promise<string> {
  const dir = path.join(home, '.config', 'opencode');
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, 'opencode.json');
}

const TOOLBOX_ENTRY = {
  type: 'local',
  command: [...TOOLBOX_STDIO_COMMAND],
  enabled: true,
};

describe('createOpencodeAdapter — detect()', () => {
  it('returns null when ~/.config/opencode/opencode.json is missing', async () => {
    const home = await makeFakeHome();
    const adapter = createOpencodeAdapter({ homedir: () => home, platform: 'darwin' });
    expect(await adapter.detect()).toBeNull();
  });

  it('returns the config path when the file exists', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    await fs.writeFile(configPath, '{}');
    const adapter = createOpencodeAdapter({ homedir: () => home, platform: 'darwin' });
    expect(await adapter.detect()).toEqual({ name: 'opencode', configPath });
  });

  it('honors OPENCODE_CONFIG env var when resolving the config path', async () => {
    const home = await makeFakeHome();
    const overridePath = path.join(home, 'custom-opencode.json');
    await fs.writeFile(overridePath, '{}');

    const adapter = createOpencodeAdapter({
      homedir: () => home,
      platform: 'darwin',
      env: { OPENCODE_CONFIG: overridePath },
    });
    expect(adapter.configPath).toBe(overridePath);
    expect(await adapter.detect()).toEqual({ name: 'opencode', configPath: overridePath });
  });
});

describe('createOpencodeAdapter — install()', () => {
  it('adds mcp.toolbox to an empty config', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    await fs.writeFile(configPath, '{}');

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('installed');
    expect(result.configPath).toBe(configPath);
    expect(result.backupPath).toBeDefined();
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    const mcp = parsed.mcp as Record<string, unknown>;
    expect(mcp.toolbox).toEqual(TOOLBOX_ENTRY);
  });

  it('preserves unrelated mcp entries and top-level keys', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    const initial = {
      $schema: 'https://opencode.ai/config.json',
      theme: 'tokyonight',
      mcp: {
        github: { type: 'local', command: ['npx', '-y', 'github-mcp'], enabled: true },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(initial, null, 2));

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(parsed.$schema).toBe(initial.$schema);
    expect(parsed.theme).toBe('tokyonight');
    const mcp = parsed.mcp as Record<string, unknown>;
    expect(mcp.github).toEqual(initial.mcp.github);
    expect(mcp.toolbox).toEqual(TOOLBOX_ENTRY);
  });

  it('is a no-op when toolbox already matches', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    await fs.writeFile(configPath, JSON.stringify({ mcp: { toolbox: TOOLBOX_ENTRY } }, null, 2));
    const before = await fs.readFile(configPath);

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('already-installed');
    expect(result.diff).toBe('');
    expect(result.backupPath).toBeUndefined();
    expect(await fs.readFile(configPath)).toEqual(before);
  });

  it('refuses to overwrite a conflicting toolbox entry without --force', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    const conflicting = {
      mcp: { toolbox: { type: 'local', command: ['old'], enabled: false } },
    };
    await fs.writeFile(configPath, JSON.stringify(conflicting, null, 2));
    const before = await fs.readFile(configPath);

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/different/i);
    expect(result.hint).toMatch(/force/);
    expect(await fs.readFile(configPath)).toEqual(before);
  });

  it('overwrites a conflicting toolbox entry with --force', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    const conflicting = {
      mcp: { toolbox: { type: 'local', command: ['old'], enabled: false } },
    };
    await fs.writeFile(configPath, JSON.stringify(conflicting, null, 2));

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: true });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('installed');
    expect(result.backupPath).toBeDefined();
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    const mcp = parsed.mcp as Record<string, unknown>;
    expect(mcp.toolbox).toEqual(TOOLBOX_ENTRY);
  });

  it('returns ok:false when the file is malformed JSON', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    await fs.writeFile(configPath, '{not json');

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/json/i);
    expect(result.hint).toBeDefined();
  });

  it('returns ok:false when mcp is not an object', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    await fs.writeFile(configPath, JSON.stringify({ mcp: ['nope'] }));

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/mcp/);
  });

  it('returns ok:false when the file is absent (OpenCode not initialized)', async () => {
    const home = await makeFakeHome();
    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/OpenCode/);
    expect(result.hint).toBeDefined();
  });

  it('parses JSONC with comments and trailing commas, preserving them on write', async () => {
    // OpenCode's docs say the config supports JSONC. JSON.parse would have
    // thrown on the comment; the modify()/applyEdits() flow must keep the
    // comment verbatim in the written file.
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    const initial =
      '{\n' +
      '  // user theme preference\n' +
      '  "theme": "tokyonight",\n' +
      '  "mcp": {\n' +
      '    /* existing entries */\n' +
      '    "github": { "type": "local", "command": ["npx", "-y", "github-mcp"], "enabled": true },\n' +
      '  },\n' +
      '}\n';
    await fs.writeFile(configPath, initial);

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const written = await fs.readFile(configPath, 'utf8');
    expect(written).toContain('// user theme preference');
    expect(written).toContain('/* existing entries */');
    // toolbox entry is present
    expect(written).toContain('"toolbox"');
    expect(written).toMatch(/"type":\s*"local"/);
    // github entry is preserved
    expect(written).toContain('"github"');
  });

  it('returns ok:false when JSONC has a real syntax error (not just comments)', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    // Missing closing brace.
    await fs.writeFile(configPath, '{ "mcp": {\n');

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/JSONC|JSON/);
    expect(result.hint).toBeDefined();
  });

  it('dryRun returns the diff without touching disk', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureOpencodeDir(home);
    await fs.writeFile(configPath, '{}');
    const before = await fs.readFile(configPath);

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: true, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('installed');
    expect(result.diff).not.toBe('');
    expect(result.backupPath).toBeUndefined();
    expect(await fs.readFile(configPath)).toEqual(before);
  });
});
