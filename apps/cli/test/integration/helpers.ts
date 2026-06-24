import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createNoopLogger,
  isProcessAlive,
  readServeState,
  saveConfig,
  serveDaemonPathsForConfig,
  type ServeDaemonState,
  type ToolBoxConfig,
} from '@rjolaverria/toolbox-core';

import {
  defaultServeDeps,
  runServe,
  type ServeDeps,
  type ServeMode,
  type ServeStartedInfo,
} from '../../src/commands/serve.js';

/**
 * Shared paths for the upstream MCP fixtures used by the integration suite.
 * These ship with `@rjolaverria/toolbox-gateway`'s upstream-client tests (M1-01, M1-02)
 * — the same fixtures power both the unit and integration coverage so the
 * surface under test is identical.
 */
export const STDIO_ECHO_FIXTURE = fileURLToPath(
  new URL(
    '../../../../packages/mcp-gateway/src/upstream-client/__tests__/__fixtures__/echo-server.mjs',
    import.meta.url,
  ),
);

export const HTTP_ECHO_FIXTURE_MODULE = new URL(
  '../../../../packages/mcp-gateway/src/upstream-client/__tests__/__fixtures__/http-echo-server.mjs',
  import.meta.url,
).href;

export const NAMED_TOOL_FIXTURE = fileURLToPath(
  new URL('./__fixtures__/named-tool-server.mjs', import.meta.url),
);

/**
 * Path to the built CLI entrypoint. The integration suite spawns this through
 * `node` so a real MCP client (`StdioClientTransport`) drives the same code
 * path a Claude / Codex / OpenCode user would hit when they run
 * `npx -y @rjolaverria/toolbox serve --stdio`. The Turbo `test:integration` task lists `build`
 * as a dependency so this file is guaranteed to exist before the suite runs.
 */
export const CLI_BIN = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

export interface TempConfigHandle {
  readonly target: string;
  readonly dir: string;
  cleanup(): Promise<void>;
}

export async function makeTempConfig(initial: ToolBoxConfig): Promise<TempConfigHandle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-cli-integration-'));
  const target = path.join(dir, 'config.json');
  await saveConfig(initial, target);
  return {
    target,
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Reserves an ephemeral loopback port by binding an HTTP socket and
 * immediately releasing it. The schema rejects port 0 (so we can't write
 * `port: 0` into a config and let the OS pick later); a tiny race window
 * here is acceptable for tests.
 */
export async function getEphemeralPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const address = probe.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to obtain ephemeral port');
  }
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Builds a config skeleton with HTTP downstream bound to a free port.
 * Tests fill in `servers` and (optionally) `progressiveDisclosure` overrides.
 */
export async function makeConfig(overrides: {
  servers: ToolBoxConfig['servers'];
  progressiveDisclosure?: Partial<ToolBoxConfig['progressiveDisclosure']>;
  tools?: ToolBoxConfig['tools'];
}): Promise<ToolBoxConfig> {
  const port = await getEphemeralPort();
  return {
    version: 1,
    server: {
      stdio: { enabled: true },
      http: { enabled: true, host: '127.0.0.1', port, path: '/mcp' },
    },
    progressiveDisclosure: {
      enabled: false,
      mode: 'session',
      bootstrapTools: true,
      autoRevealExactServerMatches: false,
      maxSearchResults: 20,
      ...overrides.progressiveDisclosure,
    },
    namespacing: { separator: '__', format: 'server__tool', collisionStrategy: 'error' },
    auth: { storage: { type: 'keychain' } },
    servers: overrides.servers,
    tools: overrides.tools ?? {},
    customTools: { sandbox: { mode: 'auto', require: false } },
  };
}

export interface InProcessServeHandle {
  readonly info: ServeStartedInfo;
  readonly stderr: { value: string };
  readonly fakeProcess: NodeJS.Process;
  /** Resolves once the runServe loop returns (after `stop()` or the process exits). */
  readonly done: Promise<number>;
  stop(): Promise<void>;
}

export interface StartInProcessServeOptions {
  configPath: string;
  mode: ServeMode;
  /**
   * When supplied, `runServe`'s loadConfig dep is replaced with one that
   * returns this exact object reference. Tests that need to mutate
   * `progressiveDisclosure.enabled` mid-session use this so they're poking
   * the same object the runtime closes over (the runtime reads
   * `deps.config.progressiveDisclosure.enabled` lazily on every request).
   */
  configObject?: ToolBoxConfig;
  /**
   * Optional override of the serve deps. Tests rarely need this — the helper
   * already swaps the cache writer to a no-op so a temporary config dir is
   * not polluted, and replaces the signal target with an EventEmitter so a
   * `SIGINT` from the helper does not nuke the test runner.
   */
  depsOverrides?: Partial<ServeDeps>;
}

/**
 * Starts ToolBox in-process via `runServe()` and waits until the downstream
 * is ready. Tests get the bound URL (HTTP) or the runtime handle (stdio) via
 * `info`. Stop the server with `handle.stop()` — this triggers a SIGINT on
 * the helper's fake process, mirroring how the real CLI shuts down.
 */
export async function startInProcessServe(
  options: StartInProcessServeOptions,
): Promise<InProcessServeHandle> {
  const stderr = { value: '' };
  const fakeProcess = new EventEmitter() as unknown as NodeJS.Process;

  const baseDeps = defaultServeDeps();
  // Skip the on-disk tool cache — the temp config dir is GC'd by the test
  // and we don't need the cache to drive any assertions here. `runServe`
  // treats either of these missing as "no cache writer".
  const { writeToolCache: _w, resolveToolCachePath: _r, ...baseDepsNoCache } = baseDeps;
  void _w;
  void _r;
  const deps: ServeDeps = {
    ...baseDepsNoCache,
    stderr: (msg) => {
      stderr.value += msg;
    },
    signalProcess: fakeProcess,
    ...(options.configObject !== undefined
      ? { loadConfig: () => Promise.resolve(options.configObject as ToolBoxConfig) }
      : {}),
    ...options.depsOverrides,
  };

  let resolveStarted!: (info: ServeStartedInfo) => void;
  const started = new Promise<ServeStartedInfo>((resolve) => {
    resolveStarted = resolve;
  });
  deps.onStarted = (info) => {
    resolveStarted(info);
  };

  const serveOptions =
    options.mode === 'stdio' ? { stdio: true as const } : { http: true as const };
  const done = runServe({ ...serveOptions, config: options.configPath }, deps);

  // Race on either the runtime starting or the runServe call short-circuiting
  // (e.g. config load failure). Whichever lands first owns the rejection.
  const info = await Promise.race([
    started,
    done.then((code) => {
      throw new Error(
        `runServe exited before onStarted fired (code=${code}). stderr:\n${stderr.value}`,
      );
    }),
  ]);

  return {
    info,
    stderr,
    fakeProcess,
    done,
    async stop() {
      // Signal-driven shutdown — the downstream attaches its own SIGINT
      // listener, so this exercises the same teardown path the real binary
      // uses when the user hits Ctrl-C.
      fakeProcess.emit('SIGINT', 'SIGINT');
      await done;
    },
  };
}

/**
 * Polls `predicate` until it returns true or `timeoutMs` elapses. Used to
 * wait for upstream sessions to enter `connected` before driving a roundtrip.
 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Returns a no-op logger so tests don't spam stderr when they spin up
 * additional supporting infrastructure (e.g. an HTTP echo upstream).
 */
export function silentLogger(): ReturnType<typeof createNoopLogger> {
  return createNoopLogger();
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCliOptions {
  /** Extra env vars merged over (and able to override) the inherited process env. */
  env?: Record<string, string>;
  /** Written to the child's stdin and then closed (used for `tlbx run --stdin`). */
  stdin?: string;
  /**
   * Upper bound on how long the child may run before it is SIGKILLed and the
   * call rejects. Keeps a hung `tlbx run`/`tlbx stop` from stalling the whole
   * suite (and from blocking the daemon cleanup that runs after each test).
   * Defaults to {@link DEFAULT_CLI_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/**
 * Default `runCli` budget. Kept comfortably below the integration suite's 30s
 * `testTimeout`/`hookTimeout` so the helper's own killer always fires first: if
 * it matched the test timeout, Vitest could abort the test before the child was
 * SIGKILLed, leaking exactly the subprocess this budget exists to reap.
 */
export const DEFAULT_CLI_TIMEOUT_MS = 20_000;

/**
 * Spawns the built `tlbx` binary as a real subprocess and resolves with its
 * exit code and captured streams. P2-06 drives the binary itself (not the
 * command functions) so the daemon auto-start, detach, and reuse paths are
 * exercised end to end exactly as an agent invoking `tlbx run` would hit them.
 *
 * The child is killed and the promise rejected if it outlives `timeoutMs`, so a
 * stuck subprocess fails loudly instead of hanging the runner — and a hung
 * `tlbx stop` can never wedge `stopDaemon` before its force-kill fallback.
 */
export function runCli(args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(
          new Error(`tlbx ${args.join(' ')} did not exit within ${String(timeoutMs)}ms; killed`),
        );
      });
    }, timeoutMs);
    // Don't let the kill timer hold the event loop open on its own.
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? -1, stdout, stderr }));
    });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

/** Reads the persisted daemon state for a config path, or `null` if none. */
export function readDaemonState(configPath: string): Promise<ServeDaemonState | null> {
  const { statePath } = serveDaemonPathsForConfig(configPath);
  return readServeState(statePath);
}

/** The pid of the daemon recorded for a config path, or `null` if none. */
export async function daemonPid(configPath: string): Promise<number | null> {
  const state = await readDaemonState(configPath);
  return state?.pid ?? null;
}

/**
 * Tears down any daemon started for a config path. Runs the real `tlbx stop`
 * first (the path under test), then force-kills and clears state as a
 * best-effort fallback so a failed assertion can never leak a detached daemon
 * out of the suite. Safe to call when no daemon is running.
 */
export async function stopDaemon(configPath: string): Promise<void> {
  // Bound the `tlbx stop` attempt tightly: if it hangs, fall straight through
  // to the force-kill below rather than letting teardown stall the suite.
  await runCli(['stop', '--config', configPath], { timeoutMs: 10_000 }).catch(() => undefined);
  const { statePath } = serveDaemonPathsForConfig(configPath);
  const state = await readServeState(statePath).catch(() => null);
  if (state !== null && isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      // best-effort: the pid may already be gone.
    }
  }
  await fs.rm(statePath, { force: true }).catch(() => undefined);
}
