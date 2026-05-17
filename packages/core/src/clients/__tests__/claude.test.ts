import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeAdapter } from '../claude.js';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-claude-adapter-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeAdapter(
  home: string,
  overrides: { afterTmpWrite?: () => Promise<void> } = {},
): ReturnType<typeof createClaudeAdapter> {
  const base = {
    homedir: () => home,
    platform: 'darwin' as const,
  };
  return createClaudeAdapter(
    overrides.afterTmpWrite ? { ...base, afterTmpWrite: overrides.afterTmpWrite } : base,
  );
}

async function readToolboxEntry(home: string): Promise<unknown> {
  const raw = await fs.readFile(path.join(home, '.claude.json'), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
  return mcpServers?.toolbox;
}

const TOOLBOX_ENTRY = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'tlbx', 'serve', '--stdio'],
  env: {},
};

describe('createClaudeAdapter — detect()', () => {
  it('returns null when ~/.claude.json is missing', async () => {
    const home = await makeFakeHome();
    const adapter = makeAdapter(home);
    expect(await adapter.detect()).toBeNull();
  });

  it('returns the config path when ~/.claude.json exists', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
    await fs.writeFile(configPath, '{}');
    const adapter = makeAdapter(home);
    expect(await adapter.detect()).toEqual({ name: 'claude', configPath });
  });

  it('still detects the client when ~/.claude.json is malformed', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
    await fs.writeFile(configPath, '{not json');
    const adapter = makeAdapter(home);
    expect(await adapter.detect()).toEqual({ name: 'claude', configPath });
  });
});

describe('createClaudeAdapter — install()', () => {
  it('adds mcpServers.toolbox to an empty config and writes a backup', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
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
    expect(result.diff).not.toBe('');

    expect(await readToolboxEntry(home)).toEqual(TOOLBOX_ENTRY);
    if (result.backupPath) {
      const backupContent = await fs.readFile(result.backupPath, 'utf8');
      expect(backupContent).toBe('{}');
    }
  });

  it('preserves existing mcpServers entries when adding toolbox', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
    const initial = {
      mcpServers: {
        github: { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: {} },
      },
      otherSetting: 'preserved',
    };
    await fs.writeFile(configPath, JSON.stringify(initial, null, 2));

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('installed');

    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mcpServers = parsed.mcpServers as Record<string, unknown>;
    expect(mcpServers.github).toEqual(initial.mcpServers.github);
    expect(mcpServers.toolbox).toEqual(TOOLBOX_ENTRY);
    expect(parsed.otherSetting).toBe('preserved');
  });

  it('is a no-op when toolbox is already installed with matching values', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
    const initial = { mcpServers: { toolbox: TOOLBOX_ENTRY } };
    await fs.writeFile(configPath, JSON.stringify(initial, null, 2));
    const originalBytes = await fs.readFile(configPath);

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('already-installed');
    expect(result.diff).toBe('');
    expect(result.backupPath).toBeUndefined();

    expect(await fs.readFile(configPath)).toEqual(originalBytes);
    const entries = await fs.readdir(home);
    expect(entries.filter((name) => name.includes('.bak.'))).toEqual([]);
  });

  it('refuses to overwrite a conflicting toolbox entry without --force', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
    const conflicting = {
      mcpServers: {
        toolbox: { type: 'stdio', command: 'old-binary', args: [], env: {} },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(conflicting, null, 2));
    const originalBytes = await fs.readFile(configPath);

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/different/i);
    expect(result.hint).toMatch(/force/);
    expect(await fs.readFile(configPath)).toEqual(originalBytes);
  });

  it('overwrites a conflicting toolbox entry with --force and writes a backup', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
    const conflicting = {
      mcpServers: {
        toolbox: { type: 'stdio', command: 'old-binary', args: [], env: {} },
      },
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

    expect(await readToolboxEntry(home)).toEqual(TOOLBOX_ENTRY);
    if (result.backupPath) {
      const backupRaw = await fs.readFile(result.backupPath, 'utf8');
      const backupParsed = JSON.parse(backupRaw) as Record<string, unknown>;
      const mcpServers = backupParsed.mcpServers as Record<string, unknown>;
      expect(mcpServers.toolbox).toEqual(conflicting.mcpServers.toolbox);
    }
  });

  it('returns ok:false with a hint when ~/.claude.json is malformed', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
    await fs.writeFile(configPath, '{not json');

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/json/i);
    expect(result.hint).toBeDefined();

    expect(await fs.readFile(configPath, 'utf8')).toBe('{not json');
    const entries = await fs.readdir(home);
    expect(entries.filter((name) => name.includes('.bak.'))).toEqual([]);
  });

  it('aborts without artifacts when the original file changes between read and rename', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
    const initial = { mcpServers: {} };
    await fs.writeFile(configPath, JSON.stringify(initial, null, 2));
    const originalBytes = await fs.readFile(configPath);

    const adapter = makeAdapter(home, {
      afterTmpWrite: async () => {
        // Simulate Claude Code rewriting ~/.claude.json (e.g. via /mcp) after
        // we read it but before we rename our tmp file over it.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await fs.writeFile(configPath, JSON.stringify({ tampered: true }) + '\n');
      },
    });
    const result = await adapter.install({ dryRun: false, force: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toMatch(/modified/i);
    expect(result.hint).toBeDefined();

    // Tampered content remains, but no backup or tmp leaked.
    const after = await fs.readFile(configPath, 'utf8');
    expect(after).toBe(JSON.stringify({ tampered: true }) + '\n');
    expect(after).not.toEqual(originalBytes.toString('utf8'));
    const entries = await fs.readdir(home);
    expect(entries.filter((name) => name.includes('.bak.'))).toEqual([]);
    expect(entries.filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('dryRun returns the diff without touching the filesystem', async () => {
    const home = await makeFakeHome();
    const configPath = path.join(home, '.claude.json');
    await fs.writeFile(configPath, '{}');
    const originalBytes = await fs.readFile(configPath);
    const beforeEntries = await fs.readdir(home);

    const adapter = makeAdapter(home);
    const result = await adapter.install({ dryRun: true, force: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe('installed');
    expect(result.diff).not.toBe('');
    expect(result.backupPath).toBeUndefined();

    expect(await fs.readFile(configPath)).toEqual(originalBytes);
    const afterEntries = await fs.readdir(home);
    expect(afterEntries).toEqual(beforeEntries);
  });
});
