import { readFile as fsReadFile } from 'node:fs/promises';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  connectDaemonClient,
  DEFAULT_NAMESPACE_SEPARATOR,
  formatExposedName,
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

/** Exit code for usage / input mistakes (bad flags, invalid JSON, missing input). */
const USAGE_EXIT = 2;
/** Exit code for runtime failures (daemon, connection, tool errors). */
const RUNTIME_EXIT = 1;

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
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolves the positional args into the exposed MCP tool name. */
function resolveExposedName(pos: RunPositionals): string {
  if (pos.tool !== undefined && pos.tool.length > 0) {
    return formatExposedName(pos.target, pos.tool, NAMESPACING);
  }
  return pos.target;
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
      message: `tlbx run: invalid JSON input: ${errorMessage(error)}\nGenerate a starting point with \`tlbx run ... --example > input.json\`.`,
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

/** Extracts a basic stdout rendering of a successful tool result (P2-03 adds full modes). */
function renderResult(result: DaemonCallToolResult): string {
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

export async function runRun(
  pos: RunPositionals,
  options: RunOptions,
  deps: RunDeps,
): Promise<number> {
  const input = await parseInput(options, deps);
  if (!input.ok) {
    deps.stderr(`${input.message}\n`);
    return USAGE_EXIT;
  }

  const exposedName = resolveExposedName(pos);

  const ensured = await deps.ensureDaemon({
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
    ...(options.logFormat !== undefined ? { logFormat: options.logFormat } : {}),
  });
  if (!ensured.ok) {
    deps.stderr(`${ensured.message}\n`);
    return ensured.code;
  }

  let client: DaemonClient;
  try {
    client = await deps.connect(ensured.daemon.url);
  } catch (error) {
    deps.stderr(
      `tlbx run: failed to connect to the daemon at ${ensured.daemon.url}: ${errorMessage(error)}\n`,
    );
    return RUNTIME_EXIT;
  }

  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === exposedName);
    if (tool === undefined) {
      deps.stderr(
        `tlbx run: unknown tool "${exposedName}". Run \`tlbx run --search <query>\` to discover available tools.\n`,
      );
      return RUNTIME_EXIT;
    }

    let args = input.args;
    if (args === undefined) {
      if (!isEmptyInputSchema(tool.inputSchema)) {
        deps.stderr(
          `tlbx run: "${exposedName}" requires input. Pass --json, --file, or --stdin.\n`,
        );
        return USAGE_EXIT;
      }
      args = {};
    }

    const result = await client.callTool({ name: exposedName, arguments: args });
    const rendered = renderResult(result);
    if (result.isError === true) {
      deps.stderr(`${rendered}\n`);
      return RUNTIME_EXIT;
    }
    deps.stdout(`${rendered}\n`);
    return 0;
  } catch (error) {
    deps.stderr(`tlbx run: ${errorMessage(error)}\n`);
    return RUNTIME_EXIT;
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
    .option('-c, --config <path>', 'override the resolved config path for this run')
    .option('--log-level <level>', 'daemon log level used when auto-starting')
    .option('--log-format <format>', 'daemon log format used when auto-starting')
    .action(async (target, tool, opts) => {
      const options: RunOptions = {
        ...(opts.json !== undefined ? { json: opts.json } : {}),
        ...(opts.file !== undefined ? { file: opts.file } : {}),
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
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
