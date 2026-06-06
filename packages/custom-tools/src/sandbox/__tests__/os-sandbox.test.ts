import type { ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ToolPermissions } from '../../manifest/import.js';
import {
  killProcessTree,
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
    cleanupAfterCommand: vi.fn(),
    ...over,
  };
}

function unsupportedProbe(): PlatformProbe {
  return {
    isSupportedPlatform: () => false,
    checkDependencies: () => ({ warnings: [], errors: [] }),
    wrapWithSandboxArgv: vi.fn(),
    cleanupAfterCommand: vi.fn(),
  };
}

function captureConfig(probe: PlatformProbe): Record<string, unknown> {
  const mock = probe.wrapWithSandboxArgv as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0]?.[2] as Record<string, unknown>;
}

describe('wrapSpawn', () => {
  it('maps filesystem:false to no writes and home reads denied except runtime roots', async () => {
    const probe = supportedProbe();
    await wrapSpawn({
      argv: BASE_ARGV,
      env: {},
      permissions: PERMS_NO_FS,
      readRoots: ['/cfg/tools/ns'],
      probe,
    });
    const cfg = captureConfig(probe) as {
      filesystem: {
        allowWrite: string[];
        denyRead: string[];
        allowRead: string[];
        denyWrite: string[];
      };
    };
    expect(cfg.filesystem.allowWrite).toEqual([]);
    expect(cfg.filesystem.denyRead).toEqual([os.homedir()]);
    // The caller-supplied read root and the OS temp dir are re-allowed.
    expect(cfg.filesystem.allowRead).toContain('/cfg/tools/ns');
    expect(cfg.filesystem.allowRead).toContain(os.tmpdir());
    // srt always re-adds its default writable paths, so they must be denied to
    // honor "no writes", while the /dev/* defaults stay writable for stdio.
    expect(cfg.filesystem.denyWrite).toContain(path.join(os.homedir(), '.claude/debug'));
    expect(cfg.filesystem.denyWrite).toContain('/tmp/claude');
    expect(cfg.filesystem.denyWrite.some((p) => p.startsWith('/dev/'))).toBe(false);
  });

  it('maps filesystem:true to writable home and tmp with reads open', async () => {
    const probe = supportedProbe();
    await wrapSpawn({ argv: BASE_ARGV, env: {}, permissions: PERMS_FS, probe });
    const cfg = captureConfig(probe) as {
      filesystem: { allowWrite: string[]; denyRead: string[] };
    };
    expect(cfg.filesystem.allowWrite).toContain(os.homedir());
    expect(cfg.filesystem.allowWrite).toContain(os.tmpdir());
    expect(cfg.filesystem.allowWrite).toContain(process.cwd());
    expect(cfg.filesystem.denyRead).toEqual([]);
  });

  it('wires cleanup to the probe cleanupAfterCommand when sandboxed', async () => {
    const probe = supportedProbe();
    const result = await wrapSpawn({ argv: BASE_ARGV, env: {}, permissions: PERMS_NO_FS, probe });
    expect(probe.cleanupAfterCommand).not.toHaveBeenCalled();
    result.cleanup();
    expect(probe.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it('keeps the wrapper env to non-secret PATH/HOME only (no tool env)', async () => {
    const probe = supportedProbe();
    const result = await wrapSpawn({ argv: BASE_ARGV, env: {}, permissions: PERMS_NO_FS, probe });
    expect(result.sandboxed).toBe(true);
    expect(result.argv[0]).toBe('/bin/bash');
    // Only the wrapper's own non-secret vars; the tool env is delivered over IPC,
    // never via this spawn env, so a tool-controlled shell var cannot land here.
    for (const key of Object.keys(result.env)) {
      expect(['PATH', 'HOME']).toContain(key);
    }
  });

  it('keeps secrets out of the wrapper command and env, but passes startup vars on the env', async () => {
    const probe = supportedProbe();
    const result = await wrapSpawn({
      argv: BASE_ARGV,
      env: { NODE_EXTRA_CA_CERTS: '/etc/ca.pem', API_TOKEN: 'super-secret' },
      permissions: PERMS_NO_FS,
      probe,
    });
    const command = (probe.wrapWithSandboxArgv as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    // No tool env value appears in the command line (ps/log-safe).
    expect(command).not.toContain('super-secret');
    expect(command).not.toContain('NODE_EXTRA_CA_CERTS');
    // The secret is never on the wrapper env either (IPC-only).
    expect(Object.keys(result.env)).not.toContain('API_TOKEN');
    // The narrow startup var is on the wrapper env so Node reads it at startup.
    expect(result.env.NODE_EXTRA_CA_CERTS).toBe('/etc/ca.pem');
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

  it('treats a missing-bubblewrap dependency error as unsupported', async () => {
    const probe = supportedProbe({
      checkDependencies: () => ({ warnings: [], errors: ['bubblewrap (bwrap) not installed'] }),
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

  it('treats a socat-only dependency error as supported (network proxy unused)', async () => {
    const probe = supportedProbe({
      checkDependencies: () => ({ warnings: [], errors: ['socat not installed'] }),
    });
    const result = await wrapSpawn({
      argv: BASE_ARGV,
      env: {},
      permissions: PERMS_NO_FS,
      probe,
      sandbox: { mode: 'auto', require: false },
    });
    expect(result.sandboxed).toBe(true);
    expect(probe.wrapWithSandboxArgv).toHaveBeenCalled();
  });

  it('killProcessTree no-ops when the child has no pid', () => {
    const kill = vi.fn();
    expect(() =>
      killProcessTree({ pid: undefined, killed: false, kill } as unknown as ChildProcess),
    ).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });

  it('killProcessTree falls back to the direct child when the group signal fails', () => {
    const kill = vi.fn();
    // A pid whose process group does not exist makes process.kill(-pid) throw,
    // so the fallback path kills the direct child instead.
    killProcessTree({ pid: 2_000_000_000, killed: false, kill } as unknown as ChildProcess);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
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
