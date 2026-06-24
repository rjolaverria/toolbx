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

import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getDefaultWritePaths,
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import { createNoopLogger, type Logger } from '@rjolaverria/toolbox-core';

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
  /** Per-command cleanup (srt Linux: decrement the active-sandbox counter, remove bwrap mounts). */
  readonly cleanupAfterCommand: () => void;
}

export const defaultPlatformProbe: PlatformProbe = {
  isSupportedPlatform: () => SandboxManager.isSupportedPlatform(),
  checkDependencies: () => SandboxManager.checkDependencies(),
  /* c8 ignore next 4 -- thin delegations; exercised only on a sandbox-capable host */
  wrapWithSandboxArgv: (command, binShell, customConfig, abortSignal) =>
    SandboxManager.wrapWithSandboxArgv(command, binShell, customConfig, abortSignal),
  cleanupAfterCommand: () => SandboxManager.cleanupAfterCommand(),
};

/** No-op cleanup for the unsandboxed paths. */
const NOOP_CLEANUP = (): void => {};

/**
 * Env vars Node reads at process startup (before the harness can apply the
 * IPC-delivered env) that are safe to place on the sandbox wrapper's environment:
 * they are non-secret, and they are not interpreted by the wrapper shell or the
 * dynamic loader, so they cannot trigger a BASH_ENV/LD_PRELOAD-style bypass. All
 * other tool env (including secrets) is delivered only over IPC.
 */
const STARTUP_WRAPPER_ENV = new Set(['NODE_EXTRA_CA_CERTS']);

/** The subset of the tool env that is safe and necessary on the wrapper env. */
function startupWrapperEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of STARTUP_WRAPPER_ENV) {
    const value = env[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * SIGKILLs a child and its descendants. After OS-sandbox wrapping the direct
 * child is the wrapper shell (`bash -c "… sandbox-exec … node harness"`), so
 * killing only its PID would orphan the Node harness. The child is spawned
 * `detached` (its own process group) and this signals the whole group, falling
 * back to the direct PID if the group send fails.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    if (!child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
    }
  }
}

/** Raised when an OS sandbox is required (`require: true`) but unavailable. */
export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError';
}

export interface WrapSpawnInput {
  /** Unsandboxed child argv: `[execPath, ...flags, harnessPath]`. */
  readonly argv: readonly string[];
  /**
   * Allowlisted tool env as name→value pairs. The full set (including secrets) is
   * delivered to the harness over IPC and applied at runtime, so secrets never
   * reach the wrapper argv or environment. Only a narrow startup allowlist
   * ({@link STARTUP_WRAPPER_ENV}) is also placed on the wrapper env so Node can
   * read it at startup. On the unsandboxed paths (no wrapper shell) the whole set
   * is the child's spawn env.
   */
  readonly env: Record<string, string>;
  readonly permissions: ToolPermissions;
  readonly sandbox?: SandboxOptions;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  /**
   * Extra directories the child must be able to read when `filesystem` is denied
   * — typically the tool entry's directory. The Node runtime root and the
   * ToolBox install root are derived automatically from `argv`; this covers
   * read roots only the caller knows (e.g. a tool stored under the config dir).
   */
  readonly readRoots?: readonly string[];
  /** Test seam: defaults to {@link defaultPlatformProbe}. */
  readonly probe?: PlatformProbe;
}

export interface WrapSpawnResult {
  readonly argv: string[];
  /**
   * Environment for the spawned (possibly wrapper) process. Carries only the
   * non-secret vars the OS-sandbox wrapper itself needs (PATH/HOME); the tool's
   * allowlisted env is delivered separately over IPC, never here, so it cannot
   * reach the wrapper shell.
   */
  readonly env: NodeJS.ProcessEnv;
  readonly sandboxed: boolean;
  /**
   * Call exactly once after the spawned process has exited. When sandboxed it
   * runs srt's per-command cleanup (Linux bwrap mount-point removal); otherwise
   * a no-op.
   */
  readonly cleanup: () => void;
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

/**
 * Walks up from `fromPath` to the *outermost* ancestor containing `node_modules`.
 * The outermost (not nearest) root is what covers a pnpm install: a package's
 * own `node_modules` only holds symlinks into the workspace-root `.pnpm` store,
 * so the real dependency files live under the topmost `node_modules`. Falls back
 * to the file's own directory when no `node_modules` ancestor exists.
 */
function outermostInstallRoot(fromPath: string): string {
  let dir = path.dirname(fromPath);
  let found: string | undefined;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules'))) {
      found = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return found ?? path.dirname(fromPath);
}

/**
 * The directories a denied-filesystem child must still read to start and run:
 * the Node runtime root (covers a home-installed Node, e.g. nvm), the ToolBox
 * install root (the harness, its sibling modules, and bundled deps), the OS temp
 * dir (srt writes its profile there), plus any caller-supplied roots (the tool
 * entry's directory, which lives under the config dir). System paths outside the
 * user's home stay readable because only the home dir is denied.
 */
function defaultReadRoots(argv: readonly string[], extra: readonly string[]): string[] {
  const execPath = argv[0] ?? process.execPath;
  const harness = argv[argv.length - 1] ?? execPath;
  return [
    path.resolve(path.dirname(execPath), '..'),
    outermostInstallRoot(harness),
    os.tmpdir(),
    ...extra,
  ];
}

/** Maps the coarse `filesystem` permission onto an srt filesystem config. */
function filesystemConfig(
  filesystemAllowed: boolean,
  readRoots: string[],
): SandboxRuntimeConfig['filesystem'] {
  if (filesystemAllowed) {
    // Reads open; writes allowed under the user's home, the OS temp dir, and the
    // current working directory (the daemon's cwd) so a tool launched from a
    // workspace outside home (e.g. /workspaces/project) can still write there.
    return {
      denyRead: [],
      allowWrite: [...new Set([os.homedir(), os.tmpdir(), process.cwd()])],
      denyWrite: [],
    };
  }
  // No writes anywhere, and reads of the user's home are denied (where secrets
  // live) except the minimum roots the child needs to run. A non-empty config
  // engages the sandbox profile, so the child runs sandboxed even though nothing
  // is writable. Reads outside home stay open so system libraries load.
  //
  // srt always merges getDefaultWritePaths() into the allowWrite list, so an
  // empty allowWrite still leaves paths like ~/.npm/_logs, ~/.claude/debug, and
  // /tmp/claude writable. Deny the non-device defaults (denyWrite takes
  // precedence over allowWrite) to honor the no-writes contract; the /dev/*
  // entries stay writable so the child can write to stdout/stderr.
  return {
    denyRead: [os.homedir()],
    allowRead: [...new Set(readRoots)],
    allowWrite: [],
    denyWrite: getDefaultWritePaths().filter((p) => !p.startsWith('/dev/')),
  };
}

/**
 * Platforms this wrapper supports. It builds POSIX-quoted `bash -c` commands and
 * relies on `sandbox-exec`/`bubblewrap` filesystem containment, so Windows is
 * excluded even when srt-win reports the platform as supported — its command
 * construction and filesystem boundary differ. Windows falls back to in-process
 * hardening (or fails closed under `require`).
 */
const POSIX_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux']);

/**
 * srt's Linux dependency check reports missing `socat` and `ripgrep` as errors,
 * but neither is needed for this wrapper's filesystem-only config: socat is only
 * for the network *proxy* (never used here), and ripgrep only expands glob
 * deny-patterns — we pass literal paths, and srt catches an rg failure anyway.
 * Ignore both so a host with working `bwrap` keeps its containment; any other
 * dependency error (e.g. missing `bwrap`) still disqualifies the OS sandbox.
 */
function disqualifyingErrors(errors: readonly string[]): readonly string[] {
  return errors.filter((message) => !/socat|ripgrep/i.test(message));
}

function isSupported(probe: PlatformProbe): boolean {
  return (
    POSIX_PLATFORMS.has(process.platform) &&
    probe.isSupportedPlatform() &&
    disqualifyingErrors(probe.checkDependencies().errors).length === 0
  );
}

/**
 * Whether the OS sandbox would be applied on this host (platform supported, deps
 * present, ignoring the network-only socat dependency). Exposed so tests gate on
 * the exact same decision `wrapSpawn` makes rather than a broader dependency check.
 */
export function isOsSandboxSupported(probe: PlatformProbe = defaultPlatformProbe): boolean {
  return isSupported(probe);
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
    // No wrapper shell: the tool env is the child's spawn env directly.
    return { argv: baseArgv, env: { ...input.env }, sandboxed: false, cleanup: NOOP_CLEANUP };
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
    return { argv: baseArgv, env: { ...input.env }, sandboxed: false, cleanup: NOOP_CLEANUP };
  }

  const command = baseArgv.map(shellQuote).join(' ');
  // The startup wrapper env vars are file paths (e.g. NODE_EXTRA_CA_CERTS). Add
  // them to the read allowlist so Node can read the file at startup even when it
  // lives under $HOME and filesystem:false denies home reads.
  const startupReadPaths = Object.values(startupWrapperEnv(input.env));
  const readRoots = defaultReadRoots(baseArgv, [...(input.readRoots ?? []), ...startupReadPaths]);
  const customConfig: Partial<SandboxRuntimeConfig> = {
    filesystem: filesystemConfig(input.permissions.filesystem, readRoots),
  };
  const { argv } = await probe.wrapWithSandboxArgv(command, undefined, customConfig, input.signal);

  // The full tool env (including secrets) is delivered over IPC and applied by the
  // harness at runtime, so secrets never appear in the wrapper argv (ps/logs) or
  // its environment. The only exception is a narrow allowlist of startup-required
  // vars Node reads before the harness runs (e.g. NODE_EXTRA_CA_CERTS): those are
  // non-secret, non-shell/non-loader vars, so passing them on the wrapper env is
  // safe — bash/sandbox-exec ignore them, and they cannot trigger a BASH_ENV-style
  // bypass. The harness still prunes the child's env to exactly the allowlist.
  const env: NodeJS.ProcessEnv = {
    ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
    ...startupWrapperEnv(input.env),
  };
  return {
    argv,
    env,
    sandboxed: true,
    cleanup: () => {
      probe.cleanupAfterCommand();
    },
  };
}
