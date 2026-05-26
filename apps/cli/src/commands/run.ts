import {
  Command,
  InvalidArgumentError,
  type CommandUnknownOpts,
} from '@commander-js/extra-typings';
import {
  readAuthExpiredMeta,
  type DaemonCallToolResult,
  type DaemonClient,
  type LogFormat,
  type LogLevel,
} from '@toolbox/core';

import { runDiscovery } from './run-discovery.js';
import { parsePositiveInt } from './server-shared.js';
import {
  defaultRunDeps,
  EXIT_AUTH,
  EXIT_DAEMON,
  EXIT_SUCCESS,
  EXIT_TIMEOUT,
  EXIT_TOOL_ERROR,
  EXIT_UNKNOWN_TOOL,
  EXIT_USAGE,
  errorMessage,
  isRecord,
  openDaemonClient,
  OUTPUT_MODES,
  resolveOutputMode,
  resolveTarget,
  type OutputMode,
  type RunDeps,
  type RunOptions,
  type RunPositionals,
  type TargetContext,
} from './run-shared.js';

export {
  defaultRunDeps,
  type RunDeps,
  type RunOptions,
  type RunPositionals,
} from './run-shared.js';

/** JSON-RPC `MethodNotFound`; the daemon uses it for unknown and disabled tools. */
const METHOD_NOT_FOUND = -32601;

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
 * and an unavailable server's auth state lands in `data.status.kind`. Unknown
 * and disabled tools arrive as a bare `MethodNotFound`.
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
  if (isRecord(error) && error.code === METHOD_NOT_FOUND) {
    return {
      kind: 'unknown_tool',
      exit: EXIT_UNKNOWN_TOOL,
      message: `tlbx run: ${errorMessage(error)}`,
    };
  }
  return { kind: 'tool_error', exit: EXIT_TOOL_ERROR, message: `tlbx run: ${errorMessage(error)}` };
}

/**
 * Classifies an `isError: true` tool result. The daemon renders an expired
 * upstream credential as an error result carrying a structured `_meta` marker
 * (rather than a thrown error) so MCP clients can show the re-auth text; here
 * that marker promotes the result to an `auth` failure with the dedicated exit
 * code. Everything else is a generic tool error.
 */
function classifyResult(result: DaemonCallToolResult): RunFailure {
  if (readAuthExpiredMeta(result._meta) !== undefined) {
    return { kind: 'auth', exit: EXIT_AUTH, message: renderText(result), result };
  }
  return { kind: 'tool_error', exit: EXIT_TOOL_ERROR, message: renderText(result), result };
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

/** Returns `true` when any discovery flag is present, routing away from execution. */
function isDiscovery(options: RunOptions): boolean {
  return (
    options.search !== undefined ||
    options.list === true ||
    options.describe === true ||
    options.schema === true ||
    options.example === true
  );
}

export async function runRun(
  pos: RunPositionals,
  options: RunOptions,
  deps: RunDeps,
): Promise<number> {
  if (isDiscovery(options)) {
    return runDiscovery(pos, options, deps);
  }

  const modeResult = resolveOutputMode(options, deps);
  if (!modeResult.ok) {
    deps.stderr(`${modeResult.message}\n`);
    return EXIT_USAGE;
  }
  const mode = modeResult.mode;

  if (pos.target === undefined || pos.target.length === 0) {
    deps.stderr(
      'tlbx run: specify a tool to run (e.g. `tlbx run <server> <tool>`), ' +
        'or use --list / --search to discover tools.\n',
    );
    return EXIT_USAGE;
  }

  const input = await parseInput(options, deps);
  if (!input.ok) {
    deps.stderr(`${input.message}\n`);
    return EXIT_USAGE;
  }

  const ctx = resolveTarget(pos);

  const opened = await openDaemonClient(options, deps);
  if (!opened.ok) {
    return emitFailure(
      { kind: 'daemon', exit: EXIT_DAEMON, message: opened.message },
      ctx,
      mode,
      deps,
    );
  }
  const client: DaemonClient = opened.client;

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

    // The listing is only consulted to make the empty-input decision below.
    // A tool can be absent here yet still callable — a server in `auth_required`
    // contributes no tools to `tools/list`, so its tools surface only once the
    // call reaches the daemon. We therefore never short-circuit a missing tool
    // as "unknown": the call is issued regardless and the daemon's response is
    // authoritative (unknown → exit 4, auth_required → exit 5, etc.).
    const tool = listed.tools.find((entry) => entry.name === ctx.exposedName);

    let args = input.args;
    if (args === undefined) {
      if (tool !== undefined && !isEmptyInputSchema(tool.inputSchema)) {
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
      return emitFailure(classifyResult(result), ctx, mode, deps);
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
    .argument('[target]', 'a fully exposed tool name, or the server name when [tool] is given')
    .argument('[tool]', 'the upstream tool name (resolves to <target>__<tool>)')
    .option('--json <json>', 'tool arguments as an inline JSON object')
    .option('--file <path>', 'read tool arguments as JSON from a file')
    .option('--stdin', 'read tool arguments as JSON from stdin')
    .option(
      '--output <mode>',
      `output mode: ${OUTPUT_MODES.join(' | ')} (default: text on a TTY, json otherwise)`,
    )
    .option('--search <query>', 'discover tools matching a query (optionally scoped by [target])')
    .option('--list', 'list every enabled tool (optionally scoped by [target])')
    .option('--describe', 'describe the resolved tool: fields and an example invocation')
    .option('--schema', "print the resolved tool's raw input schema as JSON")
    .option('--example', 'print a generated JSON argument skeleton for the resolved tool')
    .option('--limit <n>', 'cap the number of --search results', (v) => {
      try {
        return parsePositiveInt(v);
      } catch (err) {
        if (err instanceof InvalidArgumentError) {
          throw err;
        }
        throw new InvalidArgumentError(String(err));
      }
    })
    .option('-c, --config <path>', 'override the resolved config path for this run')
    .option('--log-level <level>', 'daemon log level used when auto-starting')
    .option('--log-format <format>', 'daemon log format used when auto-starting')
    .addHelpText(
      'after',
      [
        '',
        'Discovery:',
        '  tlbx run --search <query>             search every enabled tool',
        "  tlbx run <server> --list             list a server's tools",
        '  tlbx run <server> <tool> --describe  show fields and an example call',
        '  tlbx run <server> <tool> --schema    print the raw input schema',
        '  tlbx run <server> <tool> --example   print a JSON argument skeleton',
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
        ...(opts.search !== undefined ? { search: opts.search } : {}),
        ...(opts.list !== undefined ? { list: opts.list } : {}),
        ...(opts.describe !== undefined ? { describe: opts.describe } : {}),
        ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
        ...(opts.example !== undefined ? { example: opts.example } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.config !== undefined ? { config: opts.config } : {}),
        ...(opts.logLevel !== undefined ? { logLevel: opts.logLevel as LogLevel } : {}),
        ...(opts.logFormat !== undefined ? { logFormat: opts.logFormat as LogFormat } : {}),
      };
      const code = await runRun(
        {
          ...(target !== undefined ? { target } : {}),
          ...(tool !== undefined ? { tool } : {}),
        },
        options,
        defaultRunDeps(),
      );
      if (code !== 0) {
        process.exit(code);
      }
    });
}
