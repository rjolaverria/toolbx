import { readFile as fsReadFile } from 'node:fs/promises';

import {
  connectDaemonClient,
  DEFAULT_NAMESPACE_SEPARATOR,
  formatExposedName,
  parseExposedName,
  type DaemonClient,
  type LogFormat,
  type LogLevel,
  type NamespaceOptions,
} from '@toolbox/core';

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
  | { ok: true; client: DaemonClient; url: string }
  | { ok: false; message: string };

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
    return { ok: true, client, url: ensured.daemon.url };
  } catch (error) {
    return {
      ok: false,
      message: `tlbx run: failed to connect to the daemon at ${ensured.daemon.url}: ${errorMessage(error)}`,
    };
  }
}
