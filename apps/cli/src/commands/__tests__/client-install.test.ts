import { describe, expect, it, vi } from 'vitest';

import type {
  ClientAdapter,
  ClientName,
  DetectedClient,
  InstallOpts,
  InstallResult,
} from '@toolbox/core';

import {
  runClientInstall,
  type ClientInstallDeps,
  type ClientInstallOptions,
} from '../client-install.js';

interface TestHarness {
  deps: ClientInstallDeps;
  stdout: { value: string };
  stderr: { value: string };
}

interface FakeAdapterBehavior {
  name?: ClientName;
  configPath?: string;
  detect?: () => Promise<DetectedClient | null>;
  install?: (opts: InstallOpts) => Promise<InstallResult>;
}

function fakeAdapter(behavior: FakeAdapterBehavior = {}): ClientAdapter {
  const name = behavior.name ?? 'claude';
  return {
    name,
    configPath: behavior.configPath ?? '/tmp/x',
    detect:
      behavior.detect ??
      ((): Promise<DetectedClient | null> =>
        Promise.resolve({ name, configPath: behavior.configPath ?? '/tmp/x' })),
    install:
      behavior.install ??
      ((): Promise<InstallResult> => Promise.resolve({ ok: false, reason: 'unused' })),
  };
}

function makeHarness(
  adapter: ClientAdapter | null,
  options: { confirm?: () => Promise<boolean> } = {},
): TestHarness {
  const stdout = { value: '' };
  const stderr = { value: '' };
  return {
    stdout,
    stderr,
    deps: {
      write: (m) => {
        stdout.value += m;
      },
      writeErr: (m) => {
        stderr.value += m;
      },
      confirm: options.confirm ?? ((): Promise<boolean> => Promise.resolve(true)),
      resolveAdapter: () => adapter,
    },
  };
}

const baseOpts: ClientInstallOptions = {
  yes: false,
  dryRun: false,
  force: false,
};

describe('runClientInstall', () => {
  it('rejects an unknown client with exit code 1', async () => {
    const h = makeHarness(null);
    const code = await runClientInstall('cursor', baseOpts, h.deps);
    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/cursor/);
    expect(h.stderr.value).toMatch(/claude, codex, opencode/);
  });

  it('exits 1 with a "not detected" message including the configPath and friendly name', async () => {
    const adapter = fakeAdapter({
      configPath: '/fake/home/.claude.json',
      detect: () => Promise.resolve(null),
    });
    const h = makeHarness(adapter);
    const code = await runClientInstall('claude', baseOpts, h.deps);
    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/not detected at \/fake\/home\/\.claude\.json/);
    expect(h.stderr.value).toMatch(/Claude Code/);
  });

  it('prints the diff and exits 0 on --dry-run, calling install only once', async () => {
    const installCalls: InstallOpts[] = [];
    const adapter = fakeAdapter({
      install: (opts) => {
        installCalls.push(opts);
        return Promise.resolve({
          ok: true,
          status: 'installed',
          configPath: '/tmp/cfg',
          diff: '+ mcpServers.toolbox = ...',
        });
      },
    });
    const h = makeHarness(adapter);
    const code = await runClientInstall('claude', { ...baseOpts, dryRun: true }, h.deps);
    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/\+ mcpServers\.toolbox/);
    expect(installCalls).toEqual([{ dryRun: true, force: false }]);
  });

  it('returns 0 with already-installed without prompting', async () => {
    const confirm = vi.fn((): Promise<boolean> => Promise.resolve(true));
    const adapter = fakeAdapter({
      install: () =>
        Promise.resolve({
          ok: true,
          status: 'already-installed',
          configPath: '/tmp/cfg',
          diff: '',
        }),
    });
    const h = makeHarness(adapter, { confirm });
    const code = await runClientInstall('claude', baseOpts, h.deps);
    expect(code).toBe(0);
    expect(h.stdout.value).toMatch(/already wired/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('prompts before writing when --yes is not set', async () => {
    const confirm = vi.fn((): Promise<boolean> => Promise.resolve(true));
    const installCalls: InstallOpts[] = [];
    const adapter = fakeAdapter({
      install: (opts) => {
        installCalls.push(opts);
        return Promise.resolve({
          ok: true,
          status: 'installed',
          configPath: '/tmp/cfg',
          backupPath: '/tmp/cfg.bak.xyz',
          diff: '+ change',
        });
      },
    });
    const h = makeHarness(adapter, { confirm });
    const code = await runClientInstall('claude', baseOpts, h.deps);
    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(installCalls).toEqual([
      { dryRun: true, force: false },
      { dryRun: false, force: false },
    ]);
    expect(h.stdout.value).toMatch(/Wrote \/tmp\/cfg/);
    expect(h.stdout.value).toMatch(/backup at \/tmp\/cfg\.bak\.xyz/);
    expect(h.stdout.value).toMatch(/Restart Claude Code/);
  });

  it('skips the prompt with --yes', async () => {
    const confirm = vi.fn((): Promise<boolean> => Promise.resolve(true));
    const installCalls: InstallOpts[] = [];
    const adapter = fakeAdapter({
      install: (opts) => {
        installCalls.push(opts);
        return Promise.resolve({
          ok: true,
          status: 'installed',
          configPath: '/tmp/cfg',
          backupPath: '/tmp/cfg.bak.xyz',
          diff: '+ change',
        });
      },
    });
    const h = makeHarness(adapter, { confirm });
    const code = await runClientInstall('claude', { ...baseOpts, yes: true }, h.deps);
    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(installCalls).toEqual([
      { dryRun: true, force: false },
      { dryRun: false, force: false },
    ]);
  });

  it('aborts when the user declines the prompt', async () => {
    const confirm = vi.fn((): Promise<boolean> => Promise.resolve(false));
    const installCalls: InstallOpts[] = [];
    const adapter = fakeAdapter({
      install: (opts) => {
        installCalls.push(opts);
        return Promise.resolve({
          ok: true,
          status: 'installed',
          configPath: '/tmp/cfg',
          backupPath: '/tmp/cfg.bak.xyz',
          diff: '+ change',
        });
      },
    });
    const h = makeHarness(adapter, { confirm });
    const code = await runClientInstall('claude', baseOpts, h.deps);
    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/aborted/i);
    expect(installCalls).toEqual([{ dryRun: true, force: false }]);
  });

  it('forwards --force to both install calls', async () => {
    const installCalls: InstallOpts[] = [];
    const adapter = fakeAdapter({
      install: (opts) => {
        installCalls.push(opts);
        return Promise.resolve({
          ok: true,
          status: 'installed',
          configPath: '/tmp/cfg',
          backupPath: '/tmp/cfg.bak.xyz',
          diff: '+ overwrite',
        });
      },
    });
    const h = makeHarness(adapter);
    const code = await runClientInstall('claude', { ...baseOpts, yes: true, force: true }, h.deps);
    expect(code).toBe(0);
    expect(installCalls).toEqual([
      { dryRun: true, force: true },
      { dryRun: false, force: true },
    ]);
  });

  it('exits 1 when install returns ok:false on the preview', async () => {
    const adapter = fakeAdapter({
      install: () => Promise.resolve({ ok: false, reason: 'config not found', hint: 'create it' }),
    });
    const h = makeHarness(adapter);
    const code = await runClientInstall('claude', baseOpts, h.deps);
    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/config not found/);
    expect(h.stderr.value).toMatch(/create it/);
  });

  it('exits 1 when the real install returns ok:false after a successful dry-run', async () => {
    let call = 0;
    const adapter = fakeAdapter({
      install: () => {
        call++;
        if (call === 1) {
          return Promise.resolve({
            ok: true,
            status: 'installed',
            configPath: '/tmp/cfg',
            diff: '+ change',
          });
        }
        return Promise.resolve({
          ok: false,
          reason: 'another process wrote',
          hint: 'inspect /tmp/cfg.bak.xyz',
        });
      },
    });
    const h = makeHarness(adapter, { confirm: () => Promise.resolve(true) });
    const code = await runClientInstall('claude', { ...baseOpts, yes: true }, h.deps);
    expect(code).toBe(1);
    expect(h.stderr.value).toMatch(/another process/);
    expect(h.stderr.value).toMatch(/inspect/);
  });

  it('passes the chosen client name to resolveAdapter for codex and opencode too', async () => {
    const seen: string[] = [];
    const codex = fakeAdapter({
      name: 'codex',
      detect: () => Promise.resolve({ name: 'codex', configPath: '/tmp/codex' }),
      install: () =>
        Promise.resolve({
          ok: true,
          status: 'already-installed',
          configPath: '/tmp/codex',
          diff: '',
        }),
    });
    const deps: ClientInstallDeps = {
      write: () => undefined,
      writeErr: () => undefined,
      confirm: () => Promise.resolve(false),
      resolveAdapter: (name) => {
        seen.push(name);
        return codex;
      },
    };
    expect(await runClientInstall('codex', baseOpts, deps)).toBe(0);
    expect(await runClientInstall('opencode', baseOpts, deps)).toBe(0);
    expect(seen).toEqual(['codex', 'opencode']);
  });
});
