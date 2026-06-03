import * as fs from 'node:fs';
import * as path from 'node:path';

import { Command, Option } from '@commander-js/extra-typings';
import {
  clearServeState,
  computeConfigIdentity,
  createLogger,
  loadConfig,
  readServeState,
  resolveConfigPath,
  resolveToolCachePath,
  writeServeState,
  writeToolCache,
  type CachedTool,
  type CreateLoggerOptions,
  type LogFormat,
  type LogLevel,
  type ServeDaemonState,
  type ToolBoxConfig,
  type WriteToolCacheInput,
} from '@toolbox/core';
import { defaultServeDetachDeps, runServeDetached } from './serve-detach.js';
import {
  createDownstreamHttpServer,
  createDownstreamStdioServer,
  createGatewayRuntime,
  type CreateDownstreamHttpServerDeps,
  type CreateDownstreamStdioServerDeps,
  type DownstreamHttpServer,
  type DownstreamStdioServer,
  type GatewayRuntime,
} from '@toolbox/mcp-gateway';

const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
] as const satisfies readonly LogLevel[];
const LOG_FORMATS = ['pretty', 'json'] as const satisfies readonly LogFormat[];

/**
 * Env marker pointing the managed daemon at the state file it must publish
 * once its HTTP listener has bound. Carries the *path* (which a file
 * descriptor cannot), but is honored only when the {@link MANAGED_CHILD_FD}
 * handshake also proves this process was spawned by the daemon manager.
 */
export const SERVE_STATE_PATH_ENV = 'TOOLBOX_SERVE_STATE_PATH';
/** Companion marker recording the log path inside the published state. */
export const SERVE_LOG_PATH_ENV = 'TOOLBOX_SERVE_LOG_PATH';
/**
 * Marker the `tlbx run` spawner sets so the managed child binds HTTP even when
 * `server.http.enabled` is `false`. Honored only alongside the
 * {@link MANAGED_CHILD_FD} handshake — env alone is user-forgeable, so it never
 * grants the override on a plain `tlbx serve`.
 */
export const SERVE_FORCE_HTTP_ENV = 'TOOLBOX_SERVE_FORCE_HTTP';

/**
 * File descriptor the spawner wires to an inherited pipe when it launches a
 * managed daemon. A plain shell `tlbx serve` has no open fd here, so probing it
 * is what actually proves managed-child context — unlike env vars, a child
 * cannot fabricate an inherited descriptor for itself. The env markers above
 * only carry data; this handshake carries authority.
 */
export const MANAGED_CHILD_FD = 3;

/**
 * Returns `true` when {@link MANAGED_CHILD_FD} is an inherited pipe/socket,
 * i.e. this process was spawned as a managed daemon. `statFd` is injectable for
 * tests; production stats the real descriptor.
 */
export function hasManagedChildHandle(
  statFd: (fd: number) => { isFIFO: () => boolean; isSocket: () => boolean } = fs.fstatSync,
): boolean {
  try {
    const stat = statFd(MANAGED_CHILD_FD);
    return stat.isFIFO() || stat.isSocket();
  } catch {
    return false;
  }
}

export interface ServeOptions {
  stdio?: boolean;
  http?: boolean;
  /**
   * Bind the HTTP listener even when `server.http.enabled` is `false`. Derived
   * from the private {@link SERVE_FORCE_HTTP_ENV} marker (set only by the
   * `tlbx run` spawn path), never from a CLI flag, so `server.http.enabled`
   * still gates the operator-facing command.
   */
  forceHttp?: boolean;
  config?: string;
  logLevel?: LogLevel;
  logFormat?: LogFormat;
}

export type ServeMode = 'stdio' | 'http';

export interface ServeStartedInfo {
  readonly mode: ServeMode;
  readonly url?: URL;
  readonly runtime: GatewayRuntime;
}

export interface ServeDeps {
  resolvePath: () => string;
  loadConfig: (path: string) => Promise<ToolBoxConfig>;
  createLogger: (options: CreateLoggerOptions) => ReturnType<typeof createLogger>;
  createRuntime: typeof createGatewayRuntime;
  createStdio: (deps: CreateDownstreamStdioServerDeps) => DownstreamStdioServer;
  createHttp: (deps: CreateDownstreamHttpServerDeps) => DownstreamHttpServer;
  stderr: (msg: string) => void;
  processEnv: NodeJS.ProcessEnv;
  /**
   * Optional callback fired once the downstream server is listening and the
   * runtime has kicked off upstream connect attempts. Tests use this to
   * capture the bound HTTP URL and drive a real MCP client round-trip
   * before tearing the server down.
   */
  onStarted?: (info: ServeStartedInfo) => void;
  /**
   * Process used by the downstream servers to attach SIGINT/SIGTERM
   * handlers. Production passes the real `process`; tests inject a fake
   * EventEmitter so they can simulate signal-driven shutdown without
   * touching the test runner's process.
   */
  signalProcess?: NodeJS.Process;
  /**
   * Persists the visible tool registry to disk after every change so
   * `tlbx tools list` / `tlbx tools search` can read the inventory without
   * starting the gateway. Tests stub this to avoid touching the user's
   * config directory.
   */
  writeToolCache?: (input: WriteToolCacheInput, filePath: string) => Promise<void>;
  /** Resolves the on-disk path the cache is written to; defaults to alongside the config. */
  resolveToolCachePath?: (configPath: string) => string;
  /**
   * Publishes the daemon state file once the HTTP listener has bound. A
   * managed daemon (spawned by `tlbx serve --detach` / `tlbx run`) writes it
   * so the bind — not a parent-side grace timer — is what makes the daemon
   * discoverable. Defaults to the real `writeServeState`.
   */
  writeServeState?: (filePath: string, state: ServeDaemonState) => Promise<void>;
  /** Removes the published state on shutdown. Defaults to the real `clearServeState`. */
  clearServeState?: (filePath: string) => Promise<void>;
  /**
   * Reads the published state during shutdown so we only clear a record that
   * still names this daemon's pid — never a successor that bound the freed
   * port while we were tearing down. Defaults to the real `readServeState`.
   */
  readServeState?: (filePath: string) => Promise<ServeDaemonState | null>;
  /** Clock used for the state file's `startedAt`. */
  now?: () => Date;
  /** Pid recorded in the published state; defaults to `process.pid`. */
  pid?: () => number;
  /**
   * Reports whether this process was spawned as a managed daemon (the
   * {@link MANAGED_CHILD_FD} handshake). Gates all daemon-state behavior so a
   * forged env cannot opt a plain `tlbx serve` into managed mode. Defaults to
   * the real fd probe.
   */
  isManagedChild?: () => boolean;
}

export function defaultServeDeps(): ServeDeps {
  return {
    resolvePath: () => resolveConfigPath(),
    loadConfig: (path) => loadConfig(path),
    createLogger: (options) => createLogger(options),
    createRuntime: createGatewayRuntime,
    createStdio: createDownstreamStdioServer,
    createHttp: createDownstreamHttpServer,
    stderr: (msg) => {
      process.stderr.write(msg);
    },
    processEnv: process.env,
    signalProcess: process,
    writeToolCache: (input, filePath) => writeToolCache(input, filePath),
    resolveToolCachePath: (configPath) =>
      // Honour `TOOLBOX_CONFIG`-style explicit overrides: when the config path
      // is explicit, drop the cache next to it instead of in the default XDG
      // location resolved from the ambient environment.
      path.join(path.dirname(configPath), path.basename(resolveToolCachePath())),
    writeServeState: (filePath, state) => writeServeState(filePath, state),
    clearServeState: (filePath) => clearServeState(filePath),
    readServeState: (filePath) => readServeState(filePath),
    now: () => new Date(),
    pid: () => process.pid,
    isManagedChild: () => hasManagedChildHandle(),
  };
}

interface ManagedDaemon {
  readonly statePath: string;
  readonly logPath: string;
}

/**
 * Decides whether this `serve` invocation may bind HTTP past the
 * `server.http.enabled` gate. Requires both the {@link SERVE_FORCE_HTTP_ENV}
 * marker *and* the unforgeable managed-child handshake, so a user shell — which
 * can set any env var but cannot hand itself an inherited pipe — never bypasses
 * the gate on a plain `tlbx serve`. The explicit `--detach` path never forces.
 */
export function resolveForceHttp(env: NodeJS.ProcessEnv, isManagedChild: boolean): boolean {
  return isManagedChild && env[SERVE_FORCE_HTTP_ENV] === '1';
}

/**
 * Resolves the managed-daemon markers from the environment. Returns `null`
 * unless the unforgeable managed-child handshake holds, so a foreground
 * `tlbx serve` (even one with the env markers set) never reads or writes the
 * daemon state file. When active, the log path defaults to the state file's
 * sibling `serve.log` so the published record always carries a non-empty
 * `logPath`.
 */
function resolveManagedDaemon(
  env: NodeJS.ProcessEnv,
  isManagedChild: boolean,
): ManagedDaemon | null {
  if (!isManagedChild) {
    return null;
  }
  const statePath = env[SERVE_STATE_PATH_ENV];
  if (statePath === undefined || statePath.length === 0) {
    return null;
  }
  const logPathEnv = env[SERVE_LOG_PATH_ENV];
  const logPath =
    logPathEnv !== undefined && logPathEnv.length > 0
      ? logPathEnv
      : path.join(path.dirname(statePath), 'serve.log');
  return { statePath, logPath };
}

export async function runServe(options: ServeOptions, deps: ServeDeps): Promise<number> {
  if (options.stdio === true && options.http === true) {
    deps.stderr('tlbx serve: --stdio and --http are mutually exclusive\n');
    return 2;
  }
  const mode: ServeMode = options.stdio === true ? 'stdio' : 'http';

  const configPath =
    options.config !== undefined && options.config.length > 0 ? options.config : deps.resolvePath();

  let config: ToolBoxConfig;
  try {
    config = await deps.loadConfig(configPath);
  } catch (error) {
    deps.stderr(`tlbx serve: failed to load config from ${configPath}: ${errorMessage(error)}\n`);
    return 1;
  }

  if (mode === 'http' && !config.server.http.enabled && options.forceHttp !== true) {
    deps.stderr(
      'tlbx serve: --http requested but server.http.enabled is false in config; enable it first or run with --stdio\n',
    );
    return 1;
  }

  // stdio mode reserves stdout exclusively for MCP traffic. Logs go to
  // stderr, and we default to JSON so Claude Desktop's log capture stays
  // machine-parseable. HTTP mode is happy to honour the logger's TTY-aware
  // pretty default unless the user picks a format explicitly.
  const loggerOptions: CreateLoggerOptions = {
    level: options.logLevel ?? 'info',
    destination: 'stderr',
    ...(options.logFormat !== undefined
      ? { format: options.logFormat }
      : mode === 'stdio'
        ? { format: 'json' }
        : {}),
  };
  const logger = deps.createLogger(loggerOptions);

  const runtime = deps.createRuntime({
    config,
    logger,
    processEnv: deps.processEnv,
    // Locate the custom-tool manifest (and resolve relative tool entry paths)
    // alongside the resolved config so imported, enabled custom tools are
    // exposed through the gateway (P3-05).
    configDir: path.dirname(configPath),
  });
  const detachCacheWriter = startToolCacheWriter(runtime, configPath, deps, logger);
  runtime.startUpstreams();

  if (mode === 'stdio') {
    const downstream = deps.createStdio({
      logger,
      registerHandlers: runtime.registerHandlers,
      ...(deps.signalProcess !== undefined ? { process: deps.signalProcess } : {}),
    });
    try {
      await downstream.start();
    } catch (error) {
      await detachCacheWriter();
      await runtime.dispose();
      deps.stderr(`tlbx serve: failed to start stdio server: ${errorMessage(error)}\n`);
      return 1;
    }
    deps.onStarted?.({ mode, runtime });
    await downstream.done;
    await detachCacheWriter();
    await runtime.dispose();
    return 0;
  }

  const downstream = deps.createHttp({
    logger,
    http: {
      host: config.server.http.host,
      port: config.server.http.port,
      path: config.server.http.path,
    },
    registerHandlers: runtime.registerHandlers,
    ...(deps.signalProcess !== undefined ? { process: deps.signalProcess } : {}),
  });
  try {
    await downstream.start();
  } catch (error) {
    await detachCacheWriter();
    await runtime.dispose();
    deps.stderr(`tlbx serve: failed to start http server: ${errorMessage(error)}\n`);
    return 1;
  }

  // The listener is bound. A managed daemon publishes its state file now —
  // after the bind, never before — so a concurrent starter that loses the
  // port race can't observe a half-started daemon, and `tlbx stop` / `tlbx
  // run` only ever see a record backed by a live HTTP endpoint.
  const managed = resolveManagedDaemon(deps.processEnv, deps.isManagedChild?.() ?? false);
  if (managed !== null) {
    const published = await publishManagedState(
      managed,
      downstream.url,
      computeConfigIdentity(config),
      deps,
    );
    if (!published) {
      await downstream.stop();
      await detachCacheWriter();
      await runtime.dispose();
      return 1;
    }
  }

  deps.onStarted?.({ mode, url: downstream.url, runtime });
  await downstream.done;
  await detachCacheWriter();
  await runtime.dispose();
  if (managed !== null) {
    await clearManagedState(managed, deps);
  }
  return 0;
}

async function publishManagedState(
  managed: ManagedDaemon,
  url: URL,
  configHash: string,
  deps: ServeDeps,
): Promise<boolean> {
  const writeState = deps.writeServeState;
  if (writeState === undefined) {
    return true;
  }
  const state: ServeDaemonState = {
    version: 1,
    pid: (deps.pid ?? (() => process.pid))(),
    mode: 'http',
    url: url.toString(),
    logPath: managed.logPath,
    startedAt: (deps.now ?? (() => new Date()))().toISOString(),
    configHash,
  };
  try {
    await writeState(managed.statePath, state);
    return true;
  } catch (error) {
    deps.stderr(
      `tlbx serve: failed to publish daemon state ${managed.statePath}: ${errorMessage(error)}\n`,
    );
    return false;
  }
}

async function clearManagedState(managed: ManagedDaemon, deps: ServeDeps): Promise<void> {
  const clearState = deps.clearServeState;
  if (clearState === undefined) {
    return;
  }
  // Only clear a record that still names us. Once `done` resolved our listener
  // is closed, so a successor could already have bound the freed port and
  // published its own state under the same path — clearing that would orphan it.
  const readState = deps.readServeState;
  if (readState !== undefined) {
    try {
      const current = await readState(managed.statePath);
      const ourPid = (deps.pid ?? (() => process.pid))();
      if (current !== null && current.pid !== ourPid) {
        return;
      }
    } catch {
      // Best-effort: fall through to clear if we can't read the record back.
    }
  }
  await clearState(managed.statePath).catch(() => undefined);
}

function startToolCacheWriter(
  runtime: GatewayRuntime,
  configPath: string,
  deps: ServeDeps,
  logger: ReturnType<typeof createLogger>,
): () => Promise<void> {
  const writer = deps.writeToolCache;
  const resolvePath = deps.resolveToolCachePath;
  if (writer === undefined || resolvePath === undefined) {
    return () => Promise.resolve();
  }
  const cachePath = resolvePath(configPath);
  let pending: Promise<void> | null = null;
  let dirty = false;

  const flush = (): void => {
    if (pending !== null) {
      dirty = true;
      return;
    }
    const tools: CachedTool[] = runtime.toolRegistry.list().map((tool) => ({
      exposedName: tool.exposedName,
      serverName: tool.serverName,
      upstreamName: tool.upstreamName,
      source: tool.source,
      tool: tool.tool,
    }));
    pending = writer({ tools }, cachePath)
      .catch((error: unknown) => {
        logger.warn({ err: error, cachePath }, 'failed to write tool cache');
      })
      .finally(() => {
        pending = null;
        if (dirty) {
          dirty = false;
          flush();
        }
      });
  };

  // Persist the initial (likely empty) snapshot so a fresh `tlbx serve`
  // creates the file even before any upstream connects.
  flush();
  const unsubscribe = runtime.toolRegistry.subscribe(flush);
  return async () => {
    unsubscribe();
    // Drain any in-flight write — and follow-up writes triggered by the
    // `dirty` flag — so a `process.exit()` after teardown can't kill the
    // process mid-rename and leave a `.tmp` file or a half-updated cache.
    while (pending !== null) {
      await pending;
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serveCommand(): Command {
  const cmd = new Command('serve')
    .description('Start the ToolBox MCP gateway in stdio or HTTP mode.')
    .option('-s, --stdio', 'serve over stdio')
    .option('-H, --http', 'serve over Streamable HTTP using config.server.http (default)')
    .option('-d, --detach', 'fork an HTTP gateway into the background and return to the shell')
    .option('-c, --config <path>', 'override the resolved config path for this run')
    .addOption(new Option('-l, --log-level <level>', 'logger verbosity').choices(LOG_LEVELS))
    .addOption(new Option('--log-format <format>', 'logger output format').choices(LOG_FORMATS))
    .action(async (opts) => {
      if (opts.detach === true) {
        // Explicit `tlbx serve --detach` never forces HTTP — the
        // `server.http.enabled` gate applies to operator-facing commands.
        const code = await runServeDetached(opts, defaultServeDetachDeps());
        if (code !== 0) {
          process.exit(code);
        }
        return;
      }
      // The public `serve` command has no HTTP-force path at all: it can never
      // bypass `server.http.enabled` and never publishes daemon state.
      const code = await runServe(
        { ...opts },
        { ...defaultServeDeps(), isManagedChild: () => false },
      );
      if (code !== 0) {
        process.exit(code);
      }
    });
  return cmd;
}

/**
 * Internal command the daemon manager spawns for a managed child. It is not
 * part of the operator-facing surface: it refuses to run unless it can prove —
 * via the inherited-fd handshake — that it was spawned by the manager, and it
 * is the *only* path that may force HTTP past `server.http.enabled`. Register
 * it hidden so it never appears in help or competes with `serve`.
 */
export function serveManagedCommand(): Command {
  return new Command('serve-managed')
    .description('(internal) run a managed ToolBox daemon spawned by tlbx run / serve --detach')
    .option('-H, --http', 'serve over Streamable HTTP using config.server.http')
    .option('-c, --config <path>', 'override the resolved config path for this run')
    .addOption(new Option('-l, --log-level <level>', 'logger verbosity').choices(LOG_LEVELS))
    .addOption(new Option('--log-format <format>', 'logger output format').choices(LOG_FORMATS))
    .action(async (opts) => {
      if (!hasManagedChildHandle()) {
        process.stderr.write(
          'tlbx serve-managed: internal command — it must be spawned by `tlbx run` or `tlbx serve --detach`, not invoked directly\n',
        );
        process.exit(2);
        return;
      }
      // Authenticated as a managed child: the force marker is now trustworthy.
      const forceHttp = resolveForceHttp(process.env, true);
      const code = await runServe({ ...opts, http: true, forceHttp }, defaultServeDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
