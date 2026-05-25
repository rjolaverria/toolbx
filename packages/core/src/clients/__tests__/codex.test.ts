import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCodexAdapter,
  createCodexAdapterInternal,
  type InternalInstallHooks,
} from '../codex.js';
import { TOOLBOX_NPX_COMMAND, TOOLBOX_STDIO_ARGS } from '../toolbox-command.js';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-codex-adapter-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeAdapter(home: string, hooks: InternalInstallHooks = {}) {
  return createCodexAdapterInternal({ homedir: () => home, platform: 'darwin' }, hooks);
}

async function ensureCodexDir(home: string): Promise<string> {
  const dir = path.join(home, '.codex');
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, 'config.toml');
}

describe('createCodexAdapter — detect()', () => {
  it('returns null when ~/.codex/config.toml is missing', async () => {
    const home = await makeFakeHome();
    const adapter = createCodexAdapter({ homedir: () => home, platform: 'darwin' });
    expect(await adapter.detect()).toBeNull();
  });

  it('returns the config path when ~/.codex/config.toml exists', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    await fs.writeFile(configPath, '');
    const adapter = createCodexAdapter({ homedir: () => home, platform: 'darwin' });
    expect(await adapter.detect()).toEqual({ name: 'codex', configPath });
  });
});

describe('createCodexAdapter — install()', () => {
  it('adds [mcp_servers.toolbox] to an empty config', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    await fs.writeFile(configPath, '');

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('installed');
    expect(result.configPath).toBe(configPath);
    expect(result.backupPath).toBeDefined();
    expect(result.diff).not.toBe('');

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect(servers.toolbox).toEqual({
      command: TOOLBOX_NPX_COMMAND,
      args: [...TOOLBOX_STDIO_ARGS],
    });
  });

  it('preserves unrelated [mcp_servers.*] blocks and other top-level sections', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    const initial = [
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["-y", "github-mcp"]',
      '',
      '[mcp_servers.linear]',
      'command = "linear-mcp"',
      'args = []',
      '',
      '[other_section]',
      'key = "value"',
      '',
    ].join('\n');
    await fs.writeFile(configPath, initial);

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect(servers.github).toEqual({ command: 'npx', args: ['-y', 'github-mcp'] });
    expect(servers.linear).toEqual({ command: 'linear-mcp', args: [] });
    expect(servers.toolbox).toEqual({
      command: TOOLBOX_NPX_COMMAND,
      args: [...TOOLBOX_STDIO_ARGS],
    });
    const other = parsed.other_section as Record<string, unknown>;
    expect(other.key).toBe('value');
  });

  it('is a no-op when toolbox already matches', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    const initial = [
      '[mcp_servers.toolbox]',
      `command = "${TOOLBOX_NPX_COMMAND}"`,
      'args = ["-y", "@toolbox/cli", "serve", "--stdio"]',
      '',
    ].join('\n');
    await fs.writeFile(configPath, initial);
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
    const configPath = await ensureCodexDir(home);
    const initial = ['[mcp_servers.toolbox]', 'command = "old-binary"', 'args = []', ''].join('\n');
    await fs.writeFile(configPath, initial);
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

  it('overwrites a conflicting toolbox entry with --force and writes a backup', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    const initial = ['[mcp_servers.toolbox]', 'command = "old-binary"', 'args = []', ''].join('\n');
    await fs.writeFile(configPath, initial);

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: true });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('installed');
    expect(result.backupPath).toBeDefined();

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect(servers.toolbox).toEqual({
      command: TOOLBOX_NPX_COMMAND,
      args: [...TOOLBOX_STDIO_ARGS],
    });
  });

  it('emits a TOML-shaped diff covering both previous and next blocks on conflict', async () => {
    // Pins both halves of formatDiff(): the `-` block rendered from the
    // existing TOML table, and the `+` block from the merged entry. Also
    // exercises formatTomlValue's array + string branches with a different
    // shape than the empty-config case above.
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    const initial = [
      '[mcp_servers.toolbox]',
      'command = "old-binary"',
      'args = ["legacy"]',
      '',
    ].join('\n');
    await fs.writeFile(configPath, initial);

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: true, force: true });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.diff).toContain('- [mcp_servers.toolbox]');
    expect(result.diff).toContain('-   command = "old-binary"');
    expect(result.diff).toContain('-   args = ["legacy"]');
    expect(result.diff).toContain('+ [mcp_servers.toolbox]');
    expect(result.diff).toContain(`+   command = "${TOOLBOX_NPX_COMMAND}"`);
  });

  it('returns ok:false when the file is malformed TOML', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    await fs.writeFile(configPath, '[mcp_servers.toolbox\ncommand = "broken"');

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/TOML/i);
    expect(result.hint).toBeDefined();
  });

  it('returns ok:false when mcp_servers is not a table', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    await fs.writeFile(configPath, 'mcp_servers = "oops"\n');

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/mcp_servers/);
  });

  it('returns ok:false when the file is absent (Codex not initialized)', async () => {
    const home = await makeFakeHome();
    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/Codex/);
    expect(result.hint).toBeDefined();
  });

  it('emits a TOML-shaped diff that mirrors the eventual file content', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    await fs.writeFile(configPath, '');

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: true, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.diff).toContain('+ [mcp_servers.toolbox]');
    expect(result.diff).toContain(`+   command = "${TOOLBOX_NPX_COMMAND}"`);
    expect(result.diff).toContain('+   args = ["-y", "@toolbox/cli", "serve", "--stdio"]');
  });

  it('dryRun returns the diff without touching disk', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    await fs.writeFile(configPath, '');
    const before = await fs.readFile(configPath);
    const beforeEntries = await fs.readdir(path.join(home, '.codex'));

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
    expect(await fs.readdir(path.join(home, '.codex'))).toEqual(beforeEntries);
  });

  it('aborts when content changes between read and verify', async () => {
    const home = await makeFakeHome();
    const configPath = await ensureCodexDir(home);
    await fs.writeFile(configPath, '');

    const adapter = makeAdapter(home, {
      afterTmpWrite: async () => {
        await fs.writeFile(configPath, '# concurrent write\n');
      },
    });
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/modified/i);
  });
});
