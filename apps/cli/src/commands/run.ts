import { readFile as fsReadFile } from 'node:fs/promises';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  connectDaemonClient,
  DEFAULT_NAMESPACE_SEPARATOR,
  formatExposedName,
  parseExposedName,
  type DaemonCallToolResult,
  type DaemonClient,
  type LogFormat,
  type LogLevel,
  type NamespaceOptions,
} from '@toolbox/core';

import { ensureDaemon, defaultEnsureDaemonDeps, type EnsureDaemonResult } from './run-daemon.js';

const NAMESPACING: NamespaceOptions = {
  separator: DEFAULT_NAMESPACE_SEPARATOR,
  format: 'server__tool',
};

/**
 * Exit codes for `tlbx run`. Each failure category gets a distinct code so an
 * agent driving the CLI can react without parsing stderr (SPECS §5.4). The
 * table is mirrored in the command help.
 */
const EXIT_SUCCESS = 0;
/** The tool ran but reported a failure, or an upstream error without a more specific code. */
const EXIT_TOOL_ERROR = 1;
/** Usage / input mistake: bad flags, invalid JSON, missing required input. */
const EXIT_USAGE = 2;
/** Config load, daemon startup/readiness, or daemon connection failure. */
const EXIT_DAEMON = 3;
/** The resolved tool is not exposed by the daemon (unknown or disabled). */
const EXIT_UNKNOWN_TOOL = 4;
/** The target server needs authentication (`tlbx auth login <server>`). */
const EXIT_AUTH = 5;
/** The upstream tool call exceeded its configured timeout. */
const EXIT_TIMEOUT = 6;

const OUTPUT_MODES = ['text', 'json', 'mcp'] as const;
type OutputMode = (typeof OUTPUT_MODES)[number];

export interface RunPositionals {
  /** Either a full exposed name (`github__create_issue`) or a server name. */
  target: string;
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
    readStdin: readStdin,
    stdout: (msg) => {
      process.stdout.write(msg);
    },
    stderr: (msg) => {
      process.stderr.write(msg);
    },
    isStdoutTTY: process.stdout.isTTY === true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
interface TargetContext {
  exposedName: string;
  /** `null` when the exposed name carries no namespace separator. */
  server: string | null;
  tool: string;
}

/** Resolves the positional args into the exposed name and its `server`/`tool` parts. */
function resolveTarget(pos: RunPositionals): TargetContext {
  if (pos.tool !== undefined && pos.tool.length > 0) {
    return {
      exposedName: formatExposedName(pos.target, pos.tool, NAMESPACING),
      server: pos.target,
      tool: pos.tool,
    };
  }
  const parsed = parseExposedName(pos.target, NAMESPACING);
  if (parsed !== null) {
    return { exposedName: pos.target, server: parsed.serverName, tool: parsed.upstreamName };
  }
  return { exposedName: pos.target, server: null, tool: pos.target };
}

interface ParsedInput {
  ok: true;
  /** `undefined` means no input mode was supplied. */
  args: Record<string, unknown> | undefined;
}

interface InputError {
  ok: false;
  message: string;
}

/**
 * Validates the mutually-exclusive input modes and parses JSON when one is
 * supplied. Mutual exclusion and JSON validity are checked here so they fail
 * before the daemon is contacted (§5.2). Returns `args: undefined` when no
 * input mode was supplied; the empty-input decision needs the tool schema and
 * is made after the tool resolves.
 */
async function parseInput(options: RunOptions, deps: RunDeps): Promise<ParsedInput | InputError> {
  const modes: string[] = [];
  if (options.json !== undefined) {
    modes.push('--json');
  }
  if (options.file !== undefined) {
    modes.push('--file');
  }
  if (options.stdin === true) {
    modes.push('--stdin');
  }

  if (modes.length > 1) {
    return {
      ok: false,
      message: `tlbx run: ${modes.join(', ')} are mutually exclusive; pass only one input mode`,
    };
  }

  if (modes.length === 0) {
    return { ok: true, args: undefined };
  }

  let raw: string;
  if (options.json !== undefined) {
    raw = options.json;
  } else if (options.file !== undefined) {
    try {
      raw = await deps.readFile(options.file);
    } catch (error) {
      return {
        ok: false,
        message: `tlbx run: failed to read ${options.file}: ${errorMessage(error)}`,
      };
    }
  } else {
    raw = await deps.readStdin();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      ok: false,
      message: `tlbx run: invalid JSON input: ${errorMessage(error)}`,
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'tlbx run: JSON input must be an object of tool arguments' };
  }

  return { ok: true, args: parsed as Record<string, unknown> };
}

/** A tool input schema is "empty" when it declares no properties and no required fields. */
function isEmptyInputSchema(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') {
    return true;
  }
  const record = schema as { properties?: unknown; required?: unknown };
  const hasProperties =
    typeof record.properties === 'object' &&
    record.properties !== null &&
    Object.keys(record.properties).length > 0;
  const hasRequired = Array.isArray(record.required) && record.required.length > 0;
  return !hasProperties && !hasRequired;
}

/**
 * Renders a `text`-mode view of a tool result: the joined text content blocks,
 * falling back to a compact JSON rendering of the raw content for results that
 * carry no text (images, embedded resources, structured payloads).
 */
function renderText(result: DaemonCallToolResult): string {
  const content: unknown = result.content;
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
  if (text.length > 0) {
    return text;
  }
  return JSON.stringify(content);
}

/** Resolves the effective output mode from `--output` or the stdout TTY default. */
function resolveOutputMode(
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

type FailureKind = 'usage' | 'daemon' | 'unknown_tool' | 'auth' | 'timeout' | 'tool_error';

interface RunFailure {
  kind: FailureKind;
  exit: number;
  /** Human-facing diagnostic / remediation, always written to stderr. */
  message: string;
  /** The tool result, when the failure is a tool-reported error. */
  result?: DaemonCallToolResult;
}

/**
 * Classifies an error thrown by `tools/call` into a `RunFailure`. The daemon
 * surfaces routing failures as `McpError`s whose `data` carries the structured
 * reason (SPECS §5.3 gateway contract): timeouts tag `data.code === 'timeout'`,
 * and an unavailable server's auth state lands in `data.status.kind`.
 */
function classifyCallError(error: unknown): RunFailure {
  const data = isRecord(error) && isRecord(error.data) ? error.data : undefined;
  if (data !== undefined) {
    if (data.code === 'timeout') {
      return { kind: 'timeout', exit: EXIT_TIMEOUT, message: `tlbx run: ${errorMessage(error)}` };
    }
    const status = isRecord(data.status) ? data.status : undefined;
    if (
      status !== undefined &&
      (status.kind === 'auth_required' || status.kind === 'auth_expired')
    ) {
      const server = typeof data.server === 'string' ? data.server : undefined;
      const login = server !== undefined ? `tlbx auth login ${server}` : 'tlbx auth login <server>';
      return {
        kind: 'auth',
        exit: EXIT_AUTH,
        message: `tlbx run: ${errorMessage(error)}\nRun \`${login}\` to authenticate, then retry.`,
      };
    }
  }
  return { kind: 'tool_error', exit: EXIT_TOOL_ERROR, message: `tlbx run: ${errorMessage(error)}` };
}

/**
 * Emits a successful tool result on stdout in the chosen mode. `text` extracts
 * text content, `json` wraps the result in the agent-stable envelope, and `mcp`
 * prints the raw `CallToolResult`. Nothing is written to stderr on success, so
 * `text` stdout stays free of diagnostics (§5.4).
 */
function emitSuccess(
  result: DaemonCallToolResult,
  ctx: TargetContext,
  mode: OutputMode,
  deps: RunDeps,
): void {
  if (mode === 'text') {
    deps.stdout(`${renderText(result)}\n`);
    return;
  }
  if (mode === 'json') {
    const envelope = {
      ok: true,
      server: ctx.server,
      tool: ctx.tool,
      exposedName: ctx.exposedName,
      result,
    };
    deps.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  deps.stdout(`${JSON.stringify(result, null, 2)}\n`);
}

/**
 * Emits a post-resolution failure and returns its exit code. The human-facing
 * message always goes to stderr (so daemon and remediation diagnostics reach
 * stderr in every output mode). In `json` mode the agent-stable failure
 * envelope is written to stdout; in `mcp` mode a tool-reported error result is
 * printed raw so the daemon's `CallToolResult` is preserved verbatim.
 */
function emitFailure(
  failure: RunFailure,
  ctx: TargetContext,
  mode: OutputMode,
  deps: RunDeps,
): number {
  if (mode === 'json') {
    const error: Record<string, unknown> = { kind: failure.kind, message: failure.message };
    if (failure.result !== undefined) {
      error.result = failure.result;
    }
    const envelope = {
      ok: false,
      server: ctx.server,
      tool: ctx.tool,
      exposedName: ctx.exposedName,
      error,
    };
    deps.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (mode === 'mcp' && failure.result !== undefined) {
    deps.stdout(`${JSON.stringify(failure.result, null, 2)}\n`);
  }
  deps.stderr(`${failure.message}\n`);
  return failure.exit;
}

export async function runRun(
  pos: RunPositionals,
  options: RunOptions,
  deps: RunDeps,
): Promise<number> {
  const modeResult = resolveOutputMode(options, deps);
  if (!modeResult.ok) {
    deps.stderr(`${modeResult.message}\n`);
    return EXIT_USAGE;
  }
  const mode = modeResult.mode;

  const input = await parseInput(options, deps);
  if (!input.ok) {
    deps.stderr(`${input.message}\n`);
    return EXIT_USAGE;
  }

  const ctx = resolveTarget(pos);

  const ensured = await deps.ensureDaemon({
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
    ...(options.logFormat !== undefined ? { logFormat: options.logFormat } : {}),
  });
  if (!ensured.ok) {
    return emitFailure(
      { kind: 'daemon', exit: EXIT_DAEMON, message: ensured.message },
      ctx,
      mode,
      deps,
    );
  }

  let client: DaemonClient;
  try {
    client = await deps.connect(ensured.daemon.url);
  } catch (error) {
    return emitFailure(
      {
        kind: 'daemon',
        exit: EXIT_DAEMON,
        message: `tlbx run: failed to connect to the daemon at ${ensured.daemon.url}: ${errorMessage(error)}`,
      },
      ctx,
      mode,
      deps,
    );
  }

  try {
    let listed: Awaited<ReturnType<DaemonClient['listTools']>>;
    try {
      listed = await client.listTools();
    } catch (error) {
      return emitFailure(
        {
          kind: 'daemon',
          exit: EXIT_DAEMON,
          message: `tlbx run: failed to list tools from the daemon: ${errorMessage(error)}`,
        },
        ctx,
        mode,
        deps,
      );
    }

    const tool = listed.tools.find((entry) => entry.name === ctx.exposedName);
    if (tool === undefined) {
      return emitFailure(
        {
          kind: 'unknown_tool',
          exit: EXIT_UNKNOWN_TOOL,
          message: `tlbx run: unknown tool "${ctx.exposedName}".`,
        },
        ctx,
        mode,
        deps,
      );
    }

    let args = input.args;
    if (args === undefined) {
      if (!isEmptyInputSchema(tool.inputSchema)) {
        return emitFailure(
          {
            kind: 'usage',
            exit: EXIT_USAGE,
            message: `tlbx run: "${ctx.exposedName}" requires input. Pass --json, --file, or --stdin.`,
          },
          ctx,
          mode,
          deps,
        );
      }
      args = {};
    }

    let result: DaemonCallToolResult;
    try {
      result = await client.callTool({ name: ctx.exposedName, arguments: args });
    } catch (error) {
      return emitFailure(classifyCallError(error), ctx, mode, deps);
    }

    if (result.isError === true) {
      return emitFailure(
        { kind: 'tool_error', exit: EXIT_TOOL_ERROR, message: renderText(result), result },
        ctx,
        mode,
        deps,
      );
    }

    emitSuccess(result, ctx, mode, deps);
    return EXIT_SUCCESS;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function runCommand(): CommandUnknownOpts {
  return new Command('run')
    .description('Call a tool through the ToolBox daemon, auto-starting it when needed.')
    .argument('<target>', 'a fully exposed tool name, or the server name when <tool> is given')
    .argument('[tool]', 'the upstream tool name (resolves to <target>__<tool>)')
    .option('--json <json>', 'tool arguments as an inline JSON object')
    .option('--file <path>', 'read tool arguments as JSON from a file')
    .option('--stdin', 'read tool arguments as JSON from stdin')
    .option(
      '--output <mode>',
      `output mode: ${OUTPUT_MODES.join(' | ')} (default: text on a TTY, json otherwise)`,
    )
    .option('-c, --config <path>', 'override the resolved config path for this run')
    .option('--log-level <level>', 'daemon log level used when auto-starting')
    .option('--log-format <format>', 'daemon log format used when auto-starting')
    .addHelpText(
      'after',
      [
        '',
        'Exit codes:',
        '  0  success',
        '  1  the tool returned an error, or an upstream failure',
        '  2  usage error or invalid input',
        '  3  daemon startup, readiness, or connection failure',
        '  4  unknown or disabled tool',
        '  5  authentication required or expired',
        '  6  upstream tool call timed out',
      ].join('\n'),
    )
    .action(async (target, tool, opts) => {
      const options: RunOptions = {
        ...(opts.json !== undefined ? { json: opts.json } : {}),
        ...(opts.file !== undefined ? { file: opts.file } : {}),
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        ...(opts.output !== undefined ? { output: opts.output } : {}),
        ...(opts.config !== undefined ? { config: opts.config } : {}),
        ...(opts.logLevel !== undefined ? { logLevel: opts.logLevel as LogLevel } : {}),
        ...(opts.logFormat !== undefined ? { logFormat: opts.logFormat as LogFormat } : {}),
      };
      const code = await runRun(
        { target, ...(tool !== undefined ? { tool } : {}) },
        options,
        defaultRunDeps(),
      );
      if (code !== 0) {
        process.exit(code);
      }
    });
}
