import { readFile as fsReadFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  connectDaemonClient,
  DEFAULT_NAMESPACE_SEPARATOR,
  formatExposedName,
  parseExposedName,
  type DaemonClient,
  type DaemonListToolsResult,
  type LogFormat,
  type LogLevel,
  type NamespaceOptions,
  type ToolBoxConfig,
} from '@toolbox/core';
import { readToolManifest } from '@toolbox/custom-tools';

import { ensureDaemon, defaultEnsureDaemonDeps, type EnsureDaemonResult } from './run-daemon.js';

export const NAMESPACING: NamespaceOptions = {
  separator: DEFAULT_NAMESPACE_SEPARATOR,
  format: 'server__tool',
};

/**
 * Exit codes for `tlbx run`. Each failure category gets a distinct code so an
 * agent driving the CLI can react without parsing stderr (SPECS §5.4). The
 * table is mirrored in the command help.
 */
export const EXIT_SUCCESS = 0;
/** The tool ran but reported a failure, or an upstream error without a more specific code. */
export const EXIT_TOOL_ERROR = 1;
/** Usage / input mistake: bad flags, invalid JSON, missing required input. */
export const EXIT_USAGE = 2;
/** Config load, daemon startup/readiness, or daemon connection failure. */
export const EXIT_DAEMON = 3;
/** The resolved tool is not exposed by the daemon (unknown or disabled). */
export const EXIT_UNKNOWN_TOOL = 4;
/** The target server needs authentication (`tlbx auth login <server>`). */
export const EXIT_AUTH = 5;
/** The upstream tool call exceeded its configured timeout. */
export const EXIT_TIMEOUT = 6;

export const OUTPUT_MODES = ['text', 'json', 'mcp'] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export interface RunPositionals {
  /**
   * Either a full exposed name (`github__create_issue`) or a server name.
   * Optional because the discovery forms (`--search`, `--list`) accept no
   * positional or only a server filter.
   */
  target?: string | undefined;
  /** When present, `target` is the server and this is the upstream tool name. */
  tool?: string | undefined;
}

export interface RunOptions {
  json?: string | undefined;
  file?: string | undefined;
  stdin?: boolean | undefined;
  output?: string | undefined;
  config?: string | undefined;
  logLevel?: LogLevel | undefined;
  logFormat?: LogFormat | undefined;
  /** Discovery: search every enabled tool (optionally scoped by the server positional). */
  search?: string | undefined;
  /** Discovery: list every enabled tool (optionally scoped by the server positional). */
  list?: boolean | undefined;
  /** Discovery: print a human-readable summary of the resolved tool. */
  describe?: boolean | undefined;
  /** Discovery: print the resolved tool's raw input schema as JSON. */
  schema?: boolean | undefined;
  /** Discovery: print a generated JSON argument skeleton for the resolved tool. */
  example?: boolean | undefined;
  /** Discovery: cap the number of search results. */
  limit?: number | undefined;
}

export interface RunDeps {
  /** Ensures a ready daemon for the resolved config and returns its endpoint. */
  ensureDaemon: (options: {
    config?: string;
    logLevel?: LogLevel;
    logFormat?: LogFormat;
  }) => Promise<EnsureDaemonResult>;
  /** Connects to the daemon as a control-plane caller (carries the §5.3 marker). */
  connect: (url: string) => Promise<DaemonClient>;
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
  /** Whether real stdout is a TTY; selects the default output mode (§5.4). */
  isStdoutTTY: boolean;
  /**
   * Sleeps for `ms`. Used to poll a just-cold-started daemon's `tools/list`
   * while it finishes resolving custom-tool schemas (P3-05). Injectable so tests
   * exercise the poll without real time; defaults to a real timer.
   */
  delay?: (ms: number) => Promise<void>;
  /**
   * The *enabled* custom tools in the manifest for the given config directory,
   * with each tool's `timeoutMs`. `tlbx run` waits for these on a cold start so a
   * freshly enabled custom tool is callable/listable on the first invocation; the
   * wait budget is derived from `timeoutMs` because a tool's schema may take up to
   * its own timeout to resolve. Best-effort: a missing/corrupt manifest yields
   * `[]`. Injectable for tests.
   */
  readEnabledCustomTools?: (
    configDir: string,
  ) => Promise<readonly { exposedName: string; timeoutMs: number }[]>;
}

export function defaultRunDeps(): RunDeps {
  return {
    ensureDaemon: (options) => ensureDaemon(options, defaultEnsureDaemonDeps()),
    connect: (url) => connectDaemonClient(url),
    readFile: (path) => fsReadFile(path, 'utf8'),
    readStdin,
    stdout: (msg) => {
      process.stdout.write(msg);
    },
    stderr: (msg) => {
      process.stderr.write(msg);
    },
    isStdoutTTY: process.stdout.isTTY === true,
    delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    readEnabledCustomTools: async (configDir) => {
      try {
        const entries = await readToolManifest(configDir);
        return entries
          .filter((e) => e.enabled)
          .map((e) => ({ exposedName: e.exposedName, timeoutMs: e.timeoutMs }));
      } catch {
        return [];
      }
    },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The resolved call target: its exposed name and `server`/`tool` decomposition. */
export interface TargetContext {
  exposedName: string;
  /** `null` when the exposed name carries no namespace separator. */
  server: string | null;
  tool: string;
}

/** Resolves the positional args into the exposed name and its `server`/`tool` parts. */
export function resolveTarget(pos: RunPositionals): TargetContext {
  const target = pos.target ?? '';
  if (pos.tool !== undefined && pos.tool.length > 0) {
    return {
      exposedName: formatExposedName(target, pos.tool, NAMESPACING),
      server: target,
      tool: pos.tool,
    };
  }
  const parsed = parseExposedName(target, NAMESPACING);
  if (parsed !== null) {
    return { exposedName: target, server: parsed.serverName, tool: parsed.upstreamName };
  }
  return { exposedName: target, server: null, tool: target };
}

/** Resolves the effective output mode from `--output` or the stdout TTY default. */
export function resolveOutputMode(
  options: RunOptions,
  deps: RunDeps,
): { ok: true; mode: OutputMode } | { ok: false; message: string } {
  if (options.output !== undefined) {
    if ((OUTPUT_MODES as readonly string[]).includes(options.output)) {
      return { ok: true, mode: options.output as OutputMode };
    }
    return {
      ok: false,
      message: `tlbx run: invalid --output "${options.output}"; expected one of ${OUTPUT_MODES.join(', ')}`,
    };
  }
  return { ok: true, mode: deps.isStdoutTTY ? 'text' : 'json' };
}

export type OpenDaemonResult =
  | {
      ok: true;
      client: DaemonClient;
      url: string;
      config: ToolBoxConfig;
      reused: boolean;
      /** Resolved config path of the daemon, used to locate the custom-tool manifest. */
      configPath: string;
    }
  | { ok: false; message: string };

/** Floor for the cold-start wait, and the poll interval. */
const COLD_START_MIN_BUDGET_MS = 2000;
const COLD_START_POLL_MS = 100;

/**
 * Returns a `tools/list` snapshot that includes every name in
 * `expectedExposedNames` when possible.
 *
 * A managed daemon reports ready as soon as its HTTP listener binds — before it
 * has finished resolving custom-tool schemas off the hot path (P3-05). So a
 * `tlbx run` that just *cold-started* the daemon can list/search/call a freshly
 * enabled custom tool before it is registered and get a spurious "unknown tool"
 * or a missing row. When the daemon was cold-started (`reused === false`) and any
 * expected name is absent, poll the listing briefly until they all appear. A
 * reused daemon has already settled, so it is returned as-is; a name that never
 * appears (a genuinely unknown tool, or one that errored during load) simply
 * times out and the caller proceeds with the latest snapshot.
 */
export async function awaitColdStartTools(
  client: DaemonClient,
  expectedExposedNames: readonly string[],
  budgetMs: number,
  listed: DaemonListToolsResult,
  reused: boolean,
  deps: RunDeps,
): Promise<DaemonListToolsResult> {
  const allPresent = (l: DaemonListToolsResult): boolean => {
    const present = new Set(l.tools.map((t) => t.name));
    return expectedExposedNames.every((n) => present.has(n));
  };
  if (reused || expectedExposedNames.length === 0 || allPresent(listed)) {
    return listed;
  }
  const delay = deps.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + Math.max(budgetMs, COLD_START_MIN_BUDGET_MS);
  let current = listed;
  while (Date.now() < deadline && !allPresent(current)) {
    await delay(COLD_START_POLL_MS);
    current = await client.listTools();
  }
  return current;
}

/** Reads the enabled custom tools (with their timeouts) for a daemon's config. */
async function readEnabledCustomTools(
  configPath: string,
  deps: RunDeps,
): Promise<readonly { exposedName: string; timeoutMs: number }[]> {
  const read =
    deps.readEnabledCustomTools ??
    (() => Promise.resolve([] as { exposedName: string; timeoutMs: number }[]));
  return read(path.dirname(configPath));
}

/**
 * Cold-start bridge for a single target tool. Waits only when `exposedName` is an
 * enabled custom tool (upstream tools are the daemon's authority and never gate),
 * using that tool's own `timeoutMs` as the wait ceiling.
 */
export async function awaitColdStartTarget(
  client: DaemonClient,
  exposedName: string,
  configPath: string,
  listed: DaemonListToolsResult,
  reused: boolean,
  deps: RunDeps,
): Promise<DaemonListToolsResult> {
  if (reused) {
    return listed;
  }
  const customs = await readEnabledCustomTools(configPath, deps);
  const match = customs.find((c) => c.exposedName === exposedName);
  if (match === undefined) {
    return listed;
  }
  return awaitColdStartTools(client, [exposedName], match.timeoutMs, listed, reused, deps);
}

/**
 * Cold-start bridge for the whole listing (`--list` / `--search`). Waits for every
 * enabled custom tool to register, with a budget of the largest tool `timeoutMs`.
 */
export async function awaitColdStartAll(
  client: DaemonClient,
  configPath: string,
  listed: DaemonListToolsResult,
  reused: boolean,
  deps: RunDeps,
): Promise<DaemonListToolsResult> {
  if (reused) {
    return listed;
  }
  const customs = await readEnabledCustomTools(configPath, deps);
  if (customs.length === 0) {
    return listed;
  }
  const budget = Math.max(...customs.map((c) => c.timeoutMs));
  return awaitColdStartTools(
    client,
    customs.map((c) => c.exposedName),
    budget,
    listed,
    reused,
    deps,
  );
}

/**
 * Ensures a ready daemon (auto-starting it when needed, per P2-01) and opens a
 * control-plane MCP session against it. Both the readiness failure and the
 * connection failure collapse to {@link EXIT_DAEMON}; the caller emits the
 * message. The returned client must be closed by the caller.
 */
export async function openDaemonClient(
  options: RunOptions,
  deps: RunDeps,
): Promise<OpenDaemonResult> {
  const ensured = await deps.ensureDaemon({
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
    ...(options.logFormat !== undefined ? { logFormat: options.logFormat } : {}),
  });
  if (!ensured.ok) {
    return { ok: false, message: ensured.message };
  }
  try {
    const client = await deps.connect(ensured.daemon.url);
    return {
      ok: true,
      client,
      url: ensured.daemon.url,
      config: ensured.daemon.config,
      reused: ensured.daemon.reused,
      configPath: ensured.daemon.configPath,
    };
  } catch (error) {
    return {
      ok: false,
      message: `tlbx run: failed to connect to the daemon at ${ensured.daemon.url}: ${errorMessage(error)}`,
    };
  }
}
