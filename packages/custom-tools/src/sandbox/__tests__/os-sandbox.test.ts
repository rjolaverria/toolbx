import * as os from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import type { ToolPermissions } from '../../manifest/import.js';
import {
  type PlatformProbe,
  SandboxUnavailableError,
  resetSandboxWarningForTesting,
  wrapSpawn,
} from '../os-sandbox.js';

const PERMS_NO_FS: ToolPermissions = { network: false, filesystem: false, env: [] };
const PERMS_FS: ToolPermissions = { network: false, filesystem: true, env: [] };
const BASE_ARGV = ['/usr/bin/node', '--no-warnings', '/tools/harness.js'];

function supportedProbe(over: Partial<PlatformProbe> = {}): PlatformProbe {
  return {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ warnings: [], errors: [] }),
    wrapWithSandboxArgv: vi.fn((command: string) =>
      Promise.resolve({
        argv: ['/bin/bash', '-c', `sandbox ${command}`],
        env: process.env,
      }),
    ),
    ...over,
  };
}

function unsupportedProbe(): PlatformProbe {
  return {
    isSupportedPlatform: () => false,
    checkDependencies: () => ({ warnings: [], errors: [] }),
    wrapWithSandboxArgv: vi.fn(),
  };
}

function captureConfig(probe: PlatformProbe): Record<string, unknown> {
  const mock = probe.wrapWithSandboxArgv as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0]?.[2] as Record<string, unknown>;
}

describe('wrapSpawn', () => {
  it('maps filesystem:false to an empty allowWrite (no writes)', async () => {
    const probe = supportedProbe();
    await wrapSpawn({ argv: BASE_ARGV, env: {}, permissions: PERMS_NO_FS, probe });
    const cfg = captureConfig(probe) as {
      filesystem: { allowWrite: string[]; denyRead: string[] };
    };
    expect(cfg.filesystem.allowWrite).toEqual([]);
    expect(cfg.filesystem.denyRead).toEqual([]);
  });

  it('maps filesystem:true to writable home and tmp', async () => {
    const probe = supportedProbe();
    await wrapSpawn({ argv: BASE_ARGV, env: {}, permissions: PERMS_FS, probe });
    const cfg = captureConfig(probe) as { filesystem: { allowWrite: string[] } };
    expect(cfg.filesystem.allowWrite).toEqual([os.homedir(), os.tmpdir()]);
  });

  it('returns the wrapped argv and a child env carrying the allowlisted secret', async () => {
    const probe = supportedProbe();
    const result = await wrapSpawn({
      argv: BASE_ARGV,
      env: { MY_TOKEN: 'abc' },
      permissions: PERMS_NO_FS,
      probe,
    });
    expect(result.sandboxed).toBe(true);
    expect(result.argv[0]).toBe('/bin/bash');
    expect(result.env.MY_TOKEN).toBe('abc');
  });

  it('falls back to the base argv with a one-time warning when unsupported (auto)', async () => {
    resetSandboxWarningForTesting();
    const warn = vi.fn();
    const logger = {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => logger,
    } as never;
    const first = await wrapSpawn({
      argv: BASE_ARGV,
      env: {},
      permissions: PERMS_NO_FS,
      probe: unsupportedProbe(),
      logger,
      sandbox: { mode: 'auto', require: false },
    });
    const second = await wrapSpawn({
      argv: BASE_ARGV,
      env: {},
      permissions: PERMS_NO_FS,
      probe: unsupportedProbe(),
      logger,
      sandbox: { mode: 'auto', require: false },
    });
    expect(first.sandboxed).toBe(false);
    expect(first.argv).toEqual(BASE_ARGV);
    expect(second.sandboxed).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('throws SandboxUnavailableError when require is set and the platform is unsupported', async () => {
    await expect(
      wrapSpawn({
        argv: BASE_ARGV,
        env: {},
        permissions: PERMS_NO_FS,
        probe: unsupportedProbe(),
        sandbox: { mode: 'auto', require: true },
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it('treats a dependency error as unsupported', async () => {
    const probe = supportedProbe({
      checkDependencies: () => ({ warnings: [], errors: ['bubblewrap not found'] }),
    });
    const result = await wrapSpawn({
      argv: BASE_ARGV,
      env: {},
      permissions: PERMS_NO_FS,
      probe,
      sandbox: { mode: 'auto', require: false },
    });
    expect(result.sandboxed).toBe(false);
    expect(probe.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it('mode "off" never wraps, regardless of platform support', async () => {
    const probe = supportedProbe();
    const result = await wrapSpawn({
      argv: BASE_ARGV,
      env: {},
      permissions: PERMS_NO_FS,
      probe,
      sandbox: { mode: 'off', require: false },
    });
    expect(result.sandboxed).toBe(false);
    expect(result.argv).toEqual(BASE_ARGV);
    expect(probe.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });
});
