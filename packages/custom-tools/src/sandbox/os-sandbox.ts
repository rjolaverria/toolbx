/**
 * OS-level sandbox wrapper for custom-tool child processes (P3-06).
 *
 * Transforms the runner's unsandboxed child `(argv, env)` into a sandboxed
 * `{ argv, env }` using `@anthropic-ai/sandbox-runtime` (`sandbox-exec` on
 * macOS, `bubblewrap` on Linux). It is driven purely per-call: no
 * `SandboxManager.initialize()` and no network proxy. The per-call
 * `customConfig` carries only a `filesystem` block, so srt's
 * `needsNetworkRestriction` stays false and the generated profile allows
 * direct network — network access stays governed by the in-process `fetch`
 * gate in the harness, not by the OS layer (srt's proxy-based network model is
 * incompatible with a pure tool's global `fetch`; see the P3-06 design doc).
 *
 * The OS sandbox is a containment backstop layered *under* the in-process
 * hardening: if a tool escapes the harness seal and reaches a builtin, the
 * kernel still denies filesystem writes.
 */

import * as os from 'node:os';

import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { createNoopLogger, type Logger } from '@toolbox/core';

import type { ToolPermissions } from '../manifest/import.js';

/** Resolved sandbox posture the runner forwards from config. */
export interface SandboxOptions {
  /** `auto` = OS sandbox when supported, else fall back; `off` = in-process only. */
  readonly mode: 'auto' | 'off';
  /** Fail closed when no OS sandbox is available (consulted only in `auto`). */
  readonly require: boolean;
}

/**
 * Seam over the srt `SandboxManager` so the fallback/mapping logic is testable
 * on any host (including CI Linux without bubblewrap).
 */
export interface PlatformProbe {
  readonly isSupportedPlatform: () => boolean;
  readonly checkDependencies: () => { warnings: string[]; errors: string[] };
  readonly wrapWithSandboxArgv: (
    command: string,
    binShell: string | undefined,
    customConfig: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
}

export const defaultPlatformProbe: PlatformProbe = {
  isSupportedPlatform: () => SandboxManager.isSupportedPlatform(),
  checkDependencies: () => SandboxManager.checkDependencies(),
  /* c8 ignore next 2 -- thin delegation; exercised only on a sandbox-capable host */
  wrapWithSandboxArgv: (command, binShell, customConfig, abortSignal) =>
    SandboxManager.wrapWithSandboxArgv(command, binShell, customConfig, abortSignal),
};

/** Raised when an OS sandbox is required (`require: true`) but unavailable. */
export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError';
}

export interface WrapSpawnInput {
  /** Unsandboxed child argv: `[execPath, ...flags, harnessPath]`. */
  readonly argv: readonly string[];
  /** Allowlisted env (secrets) the child should see. */
  readonly env: NodeJS.ProcessEnv;
  readonly permissions: ToolPermissions;
  readonly sandbox?: SandboxOptions;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  /** Test seam: defaults to {@link defaultPlatformProbe}. */
  readonly probe?: PlatformProbe;
}

export interface WrapSpawnResult {
  readonly argv: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly sandboxed: boolean;
}

const DEFAULT_SANDBOX_OPTIONS: SandboxOptions = { mode: 'auto', require: false };

/** Latched true after the auto-mode capability warning is emitted (per process). */
let warnedUnavailable = false;

/** Reset the one-time-warning latch. Test-only. */
export function resetSandboxWarningForTesting(): void {
  warnedUnavailable = false;
}

/** POSIX single-quote escaping so one argv element becomes one safe shell word. */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/** Maps the coarse `filesystem` permission onto an srt filesystem config. */
function filesystemConfig(filesystemAllowed: boolean): SandboxRuntimeConfig['filesystem'] {
  if (filesystemAllowed) {
    // Reads open; writes allowed under the user's home and the OS temp dir.
    return { denyRead: [], allowWrite: [os.homedir(), os.tmpdir()], denyWrite: [] };
  }
  // Reads open; no writes anywhere. A non-empty filesystem config still engages
  // the sandbox profile (a write restriction is present), so the child runs
  // sandboxed even though nothing is writable.
  return { denyRead: [], allowWrite: [], denyWrite: [] };
}

function isSupported(probe: PlatformProbe): boolean {
  return probe.isSupportedPlatform() && probe.checkDependencies().errors.length === 0;
}

/**
 * Returns the argv + env to spawn for one custom-tool child, wrapping it in the
 * OS sandbox when available. `sandboxed` reports whether the OS boundary was
 * applied. Throws {@link SandboxUnavailableError} when `require` is set and no
 * OS sandbox is available.
 */
export async function wrapSpawn(input: WrapSpawnInput): Promise<WrapSpawnResult> {
  const logger = input.logger ?? createNoopLogger();
  const options = input.sandbox ?? DEFAULT_SANDBOX_OPTIONS;
  const probe = input.probe ?? defaultPlatformProbe;
  const baseArgv = [...input.argv];

  if (options.mode === 'off') {
    return { argv: baseArgv, env: input.env, sandboxed: false };
  }

  if (!isSupported(probe)) {
    if (options.require) {
      throw new SandboxUnavailableError(
        'OS sandbox is required (customTools.sandbox.require) but unavailable on this host',
      );
    }
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      logger.warn(
        { platform: process.platform },
        'OS sandbox unavailable; running custom tools with in-process hardening only',
      );
    }
    return { argv: baseArgv, env: input.env, sandboxed: false };
  }

  const command = baseArgv.map(shellQuote).join(' ');
  const customConfig: Partial<SandboxRuntimeConfig> = {
    filesystem: filesystemConfig(input.permissions.filesystem),
  };
  const { argv } = await probe.wrapWithSandboxArgv(command, undefined, customConfig, input.signal);

  // srt returns the full `process.env` (only proxy vars would differ, and we
  // configure no network, so there are none). Ignore it: the child sees only the
  // allowlisted env plus the PATH/HOME the wrapper (bash → sandbox-exec/bwrap)
  // needs to resolve its own binaries. PATH/HOME are non-secret.
  const env: NodeJS.ProcessEnv = {
    ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
    ...input.env,
  };
  return { argv, env, sandboxed: true };
}
