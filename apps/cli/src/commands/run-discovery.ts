import {
  searchTools,
  type DaemonClient,
  type DaemonListToolsResult,
  type RegisteredToolView,
  type SearchMatchedField,
} from '@toolbox/core';
import { BOOTSTRAP_TOOL_META_KEY } from '@toolbox/mcp-gateway';

import {
  EXIT_DAEMON,
  EXIT_SUCCESS,
  EXIT_UNKNOWN_TOOL,
  EXIT_USAGE,
  errorMessage,
  isRecord,
  NAMESPACING,
  openDaemonClient,
  resolveOutputMode,
  resolveTarget,
  type RunDeps,
  type RunOptions,
  type RunPositionals,
} from './run-shared.js';

/** A tool surfaced by the daemon's control-plane `tools/list`, ready to render. */
interface DiscoveredTool {
  exposedName: string;
  /** Server segment of the exposed name (empty for a non-namespaced name). */
  serverName: string;
  upstreamName: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: unknown;
}

export type ListedTool = DaemonListToolsResult['tools'][number];

/**
 * Identifies a gateway bootstrap tool by the `_meta` marker the daemon stamps
 * onto its `tools/list` descriptor (§5.3), rather than by exposed name. A real
 * upstream tool that happens to share a bootstrap name (a server literally
 * named `toolbox` with bootstrap tools disabled) carries no marker and is
 * therefore treated as a normal upstream tool.
 */
function isBootstrapTool(tool: ListedTool): boolean {
  const meta = tool._meta;
  return isRecord(meta) && meta[BOOTSTRAP_TOOL_META_KEY] === true;
}

/**
 * Placeholder emitted by `--example` for a property whose JSON Schema type
 * cannot be resolved to a concrete skeleton value (unions, missing `type`,
 * exotic constructs). The marker keeps the output valid JSON while signalling
 * that the field needs a hand-written value.
 */
const EXAMPLE_PLACEHOLDER = '<unsupported>';

/** Caps recursion through nested schemas when generating an example skeleton. */
const EXAMPLE_MAX_DEPTH = 8;

/**
 * Projects the daemon's `tools/list` into discovery rows. ToolBox's own
 * bootstrap tools are dropped: discovery is about upstream and custom tools,
 * and excluding them keeps `--search` ranking aligned with
 * `toolbox__search_tools`, which only searches the upstream registry.
 */
function buildDiscoveredTools(listed: readonly ListedTool[]): DiscoveredTool[] {
  return listed
    .filter((tool) => !isBootstrapTool(tool))
    .map((tool) => {
      const parts = tool.name.split(NAMESPACING.separator);
      const serverName = parts.length > 1 ? (parts[0] ?? '') : '';
      const upstreamName =
        parts.length > 1 ? parts.slice(1).join(NAMESPACING.separator) : tool.name;
      return {
        exposedName: tool.name,
        serverName,
        upstreamName,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
    });
}

/** Re-projects discovered tools into the search engine's view shape. */
function toSearchViews(listed: readonly ListedTool[]): RegisteredToolView[] {
  return buildDiscoveredTools(listed).map((tool) => {
    const original = listed.find((entry) => entry.name === tool.exposedName);
    return {
      exposedName: tool.exposedName,
      serverName: tool.serverName,
      upstreamName: tool.upstreamName,
      tool: (original ?? {
        name: tool.exposedName,
        inputSchema: tool.inputSchema,
      }) as RegisteredToolView['tool'],
    };
  });
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function formatTable(headers: readonly string[], cells: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((cell) => (cell[i] ?? '').length)),
  );
  const lines: string[] = [];
  lines.push(headers.map((h, i) => pad(h, widths[i] ?? h.length)).join('  '));
  for (const cell of cells) {
    lines.push(cell.map((value, i) => pad(value, widths[i] ?? value.length)).join('  '));
  }
  return `${lines.join('\n')}\n`;
}

const DESCRIPTION_CLAMP = 60;

/** First line of a description, clamped for table display. */
function clampDescription(description: string | undefined): string {
  if (description === undefined) {
    return '';
  }
  const firstLine = description.split('\n')[0] ?? '';
  if (firstLine.length <= DESCRIPTION_CLAMP) {
    return firstLine;
  }
  return `${firstLine.slice(0, DESCRIPTION_CLAMP - 1)}…`;
}

interface SchemaField {
  name: string;
  type?: string | undefined;
  description?: string | undefined;
}

/** Renders a JSON Schema `type` (string or array) into a display string. */
function typeString(type: unknown): string | undefined {
  if (typeof type === 'string') {
    return type;
  }
  if (Array.isArray(type)) {
    const named = type.filter((entry): entry is string => typeof entry === 'string');
    return named.length > 0 ? named.join('|') : undefined;
  }
  return undefined;
}

/** Splits an object schema's properties into required and optional field lists. */
function describeFields(schema: unknown): { required: SchemaField[]; optional: SchemaField[] } {
  if (!isRecord(schema)) {
    return { required: [], optional: [] };
  }
  const props = isRecord(schema.properties) ? schema.properties : {};
  const requiredNames = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  const required: SchemaField[] = [];
  const optional: SchemaField[] = [];
  for (const [name, value] of Object.entries(props)) {
    const type = typeString(isRecord(value) ? value.type : undefined);
    const description =
      isRecord(value) && typeof value.description === 'string' ? value.description : undefined;
    const field: SchemaField = {
      name,
      ...(type !== undefined ? { type } : {}),
      ...(description !== undefined ? { description } : {}),
    };
    (requiredNames.has(name) ? required : optional).push(field);
  }
  return { required, optional };
}

/**
 * Generates a JSON skeleton from a tool's input schema. Concrete `type`s map to
 * a representative empty value; `default`/`const`/`enum`/`examples` are honored
 * when present. Constructs the generator can't resolve (unions, untyped nodes)
 * collapse to {@link EXAMPLE_PLACEHOLDER} so the output stays valid JSON.
 */
function generateExample(schema: unknown, depth = 0): unknown {
  if (depth > EXAMPLE_MAX_DEPTH || !isRecord(schema)) {
    return EXAMPLE_PLACEHOLDER;
  }
  if ('default' in schema) {
    return schema.default;
  }
  if ('const' in schema) {
    return schema.const;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  const type = typeof schema.type === 'string' ? schema.type : undefined;
  switch (type) {
    case 'object': {
      const props = isRecord(schema.properties) ? schema.properties : {};
      const out: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(props)) {
        out[name] = generateExample(value, depth + 1);
      }
      return out;
    }
    case 'array': {
      const items = schema.items;
      return isRecord(items) ? [generateExample(items, depth + 1)] : [];
    }
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return EXAMPLE_PLACEHOLDER;
  }
}

/** Characters that need no quoting inside a POSIX shell word. */
const SHELL_SAFE = /^[A-Za-z0-9_./:@%+=-]+$/;

/**
 * Renders a value as a single safe POSIX shell word. Already-safe values pass
 * through unquoted for readability; anything else is single-quoted with
 * embedded single quotes escaped as `'\''` (close quote, escaped quote,
 * reopen). Both the tool name (upstream names are not shell-constrained) and
 * the JSON payload pass through here.
 */
export function shellArg(value: string): string {
  if (value.length > 0 && SHELL_SAFE.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Builds a copy-pasteable `tlbx run` invocation seeded with a JSON skeleton. */
function exampleCommand(exposedName: string, schema: unknown): string {
  const json = JSON.stringify(generateExample(schema));
  return `tlbx run ${shellArg(exposedName)} --json ${shellArg(json)}`;
}

/** Finds nearby tools for an unknown-tool error using the shared search ranking. */
function suggestTools(reference: string, listed: readonly ListedTool[]): string[] {
  const hits = searchTools(reference, toSearchViews(listed), { limit: 5 });
  return hits.map((hit) => hit.tool.exposedName);
}

/**
 * Builds the "unknown tool" diagnostic, listing the nearest enabled tools by
 * the shared search ranking (§5.5). Shared with the execution path (`tlbx run`
 * proper) so a `MethodNotFound` from `tools/call` and a missing target in
 * discovery surface identical "did you mean" guidance.
 */
export function unknownToolMessage(exposedName: string, listed: readonly ListedTool[]): string {
  const suggestions = suggestTools(exposedName, listed);
  if (suggestions.length === 0) {
    return (
      `tlbx run: unknown tool "${exposedName}". ` +
      'Use `tlbx run --list` to see the available tools.'
    );
  }
  return [
    `tlbx run: unknown tool "${exposedName}". Did you mean:`,
    ...suggestions.map((name) => `  ${name}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderList(
  tools: readonly DiscoveredTool[],
  json: boolean,
  server: string | undefined,
): string {
  if (json) {
    const rows = tools.map((tool) => ({
      exposedName: tool.exposedName,
      serverName: tool.serverName,
      upstreamName: tool.upstreamName,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      enabled: true,
    }));
    return `${JSON.stringify(rows, null, 2)}\n`;
  }
  if (tools.length === 0) {
    return server !== undefined
      ? `No enabled tools for server "${server}".\n`
      : 'No enabled tools. Add a server with `tlbx server add-stdio` or `add-http`.\n';
  }
  const headers = ['EXPOSED', 'SERVER', 'TOOL', 'ENABLED', 'DESCRIPTION'];
  const cells = tools.map((tool) => [
    tool.exposedName,
    tool.serverName,
    tool.upstreamName,
    'yes',
    clampDescription(tool.description),
  ]);
  return formatTable(headers, cells);
}

interface SearchRow {
  exposedName: string;
  serverName: string;
  upstreamName: string;
  title?: string | undefined;
  description?: string | undefined;
  score: number;
  matchedFields: readonly SearchMatchedField[];
}

function renderSearch(rows: readonly SearchRow[], json: boolean): string {
  if (json) {
    return `${JSON.stringify(rows, null, 2)}\n`;
  }
  if (rows.length === 0) {
    return 'No matches.\n';
  }
  const headers = ['EXPOSED', 'SERVER', 'TOOL', 'SCORE', 'MATCHED'];
  const cells = rows.map((row) => [
    row.exposedName,
    row.serverName,
    row.upstreamName,
    String(row.score),
    row.matchedFields.join(','),
  ]);
  return formatTable(headers, cells);
}

function renderDescribe(tool: DiscoveredTool, json: boolean): string {
  const { required, optional } = describeFields(tool.inputSchema);
  const command = exampleCommand(tool.exposedName, tool.inputSchema);
  if (json) {
    const payload = {
      exposedName: tool.exposedName,
      serverName: tool.serverName,
      upstreamName: tool.upstreamName,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      required,
      optional,
      example: { arguments: generateExample(tool.inputSchema), command },
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  const lines: string[] = [tool.exposedName];
  if (tool.title !== undefined && tool.title.length > 0) {
    lines.push(tool.title);
  }
  if (tool.description !== undefined && tool.description.length > 0) {
    lines.push('', tool.description);
  }
  lines.push('', `Server: ${tool.serverName || '(none)'}    Tool: ${tool.upstreamName}`);
  lines.push('', renderFieldSection('Required', required));
  lines.push(renderFieldSection('Optional', optional));
  lines.push('Example:', `  ${command}`);
  return `${lines.join('\n')}\n`;
}

function renderFieldSection(label: string, fields: readonly SchemaField[]): string {
  if (fields.length === 0) {
    return `${label}: (none)\n`;
  }
  const lines = [`${label}:`];
  for (const field of fields) {
    const type = field.type !== undefined ? ` (${field.type})` : '';
    const description = field.description !== undefined ? ` — ${field.description}` : '';
    lines.push(`  ${field.name}${type}${description}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

type DiscoveryKind = 'search' | 'list' | 'describe' | 'schema' | 'example';

/** Validates the discovery flag combination, returning the single active mode. */
function resolveDiscoveryKind(
  options: RunOptions,
): { ok: true; kind: DiscoveryKind } | { ok: false; message: string } {
  const active: DiscoveryKind[] = [];
  if (options.search !== undefined) {
    active.push('search');
  }
  if (options.list === true) {
    active.push('list');
  }
  if (options.describe === true) {
    active.push('describe');
  }
  if (options.schema === true) {
    active.push('schema');
  }
  if (options.example === true) {
    active.push('example');
  }
  if (active.length > 1) {
    return {
      ok: false,
      message: `tlbx run: ${active.map((k) => `--${k}`).join(', ')} are mutually exclusive; use one discovery mode`,
    };
  }
  const kind = active[0];
  if (kind === undefined) {
    // Unreachable: runDiscovery is only entered when a discovery flag is set.
    return { ok: false, message: 'tlbx run: no discovery mode selected' };
  }
  if (options.json !== undefined || options.file !== undefined || options.stdin === true) {
    return {
      ok: false,
      message: 'tlbx run: discovery flags take no tool input (--json/--file/--stdin)',
    };
  }
  return { ok: true, kind };
}

/**
 * Handles the `tlbx run` discovery forms (SPECS §5.2, §5.6). Every form
 * auto-starts/reuses the daemon (P2-01) and reads its control-plane
 * `tools/list`, which returns the full enabled tool set regardless of the
 * progressive-disclosure revealed set (§5.3).
 */
export async function runDiscovery(
  pos: RunPositionals,
  options: RunOptions,
  deps: RunDeps,
): Promise<number> {
  const kindResult = resolveDiscoveryKind(options);
  if (!kindResult.ok) {
    deps.stderr(`${kindResult.message}\n`);
    return EXIT_USAGE;
  }
  const kind = kindResult.kind;

  const modeResult = resolveOutputMode(options, deps);
  if (!modeResult.ok) {
    deps.stderr(`${modeResult.message}\n`);
    return EXIT_USAGE;
  }
  // `mcp` means a raw MCP `CallToolResult` (the run output contract, §5.4).
  // Discovery produces no tool result, so honor only `text` and `json` and
  // reject `mcp` rather than silently emitting synthesized JSON in its place.
  if (modeResult.mode === 'mcp') {
    deps.stderr('tlbx run: --output mcp is not supported for discovery; use text or json.\n');
    return EXIT_USAGE;
  }
  const json = modeResult.mode === 'json';

  // Shape-validate the positionals against the chosen mode before any daemon
  // contact, so a misuse fails fast with exit 2.
  if (kind === 'list' || kind === 'search') {
    if (pos.tool !== undefined && pos.tool.length > 0) {
      deps.stderr(
        `tlbx run: --${kind} takes an optional server name, not a tool. ` +
          `Try \`tlbx run ${pos.target ?? '<server>'} --${kind}${kind === 'search' ? ` ${options.search ?? ''}` : ''}\`.\n`,
      );
      return EXIT_USAGE;
    }
    // The positional filter is a server name, never a tool. Server names cannot
    // contain the namespace separator (enforced at config load), so a `target`
    // that does is a misused exposed tool name — reject it rather than silently
    // matching nothing.
    if (pos.target !== undefined && pos.target.includes(NAMESPACING.separator)) {
      deps.stderr(
        `tlbx run: --${kind} takes a server name, but "${pos.target}" looks like a tool name. ` +
          `Drop the "${NAMESPACING.separator}<tool>" suffix to filter by server.\n`,
      );
      return EXIT_USAGE;
    }
    if (kind === 'search' && (options.search ?? '').trim().length === 0) {
      deps.stderr('tlbx run: --search requires a non-empty query.\n');
      return EXIT_USAGE;
    }
  } else if (pos.target === undefined || pos.target.length === 0) {
    deps.stderr(
      `tlbx run: --${kind} needs a tool (e.g. \`tlbx run <server> <tool> --${kind}\`).\n`,
    );
    return EXIT_USAGE;
  }

  const opened = await openDaemonClient(options, deps);
  if (!opened.ok) {
    deps.stderr(`${opened.message}\n`);
    return EXIT_DAEMON;
  }
  const client: DaemonClient = opened.client;

  try {
    let listed: DaemonListToolsResult;
    try {
      listed = await client.listTools();
    } catch (error) {
      deps.stderr(`tlbx run: failed to list tools from the daemon: ${errorMessage(error)}\n`);
      return EXIT_DAEMON;
    }

    switch (kind) {
      case 'list':
        return runList(listed.tools, pos.target, json, deps);
      case 'search':
        return runSearch(listed.tools, options.search ?? '', pos.target, options.limit, json, deps);
      default:
        return runSingleTool(kind, listed.tools, pos, json, deps);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

function runList(
  listed: readonly ListedTool[],
  server: string | undefined,
  json: boolean,
  deps: RunDeps,
): number {
  let tools = buildDiscoveredTools(listed);
  if (server !== undefined && server.length > 0) {
    tools = tools.filter((tool) => tool.serverName === server);
  }
  tools.sort((a, b) => {
    if (a.serverName !== b.serverName) {
      return a.serverName < b.serverName ? -1 : 1;
    }
    if (a.upstreamName === b.upstreamName) {
      return 0;
    }
    return a.upstreamName < b.upstreamName ? -1 : 1;
  });
  deps.stdout(
    renderList(tools, json, server !== undefined && server.length > 0 ? server : undefined),
  );
  return EXIT_SUCCESS;
}

function runSearch(
  listed: readonly ListedTool[],
  query: string,
  server: string | undefined,
  limit: number | undefined,
  json: boolean,
  deps: RunDeps,
): number {
  // The empty-query guard runs in `runDiscovery` before the daemon is opened.
  let views = toSearchViews(listed);
  if (server !== undefined && server.length > 0) {
    views = views.filter((view) => view.serverName === server);
  }
  const ranked = searchTools(query, views, limit !== undefined ? { limit } : {});
  const rows: SearchRow[] = ranked.map((hit) => ({
    exposedName: hit.tool.exposedName,
    serverName: hit.tool.serverName,
    upstreamName: hit.tool.upstreamName,
    ...(hit.tool.tool.title !== undefined ? { title: hit.tool.tool.title } : {}),
    ...(hit.tool.tool.description !== undefined ? { description: hit.tool.tool.description } : {}),
    score: hit.score,
    matchedFields: hit.matchedFields,
  }));
  deps.stdout(renderSearch(rows, json));
  return EXIT_SUCCESS;
}

function runSingleTool(
  kind: 'describe' | 'schema' | 'example',
  listed: readonly ListedTool[],
  pos: RunPositionals,
  json: boolean,
  deps: RunDeps,
): number {
  const ctx = resolveTarget(pos);
  const match = buildDiscoveredTools(listed).find((tool) => tool.exposedName === ctx.exposedName);
  if (match === undefined) {
    deps.stderr(`${unknownToolMessage(ctx.exposedName, listed)}\n`);
    return EXIT_UNKNOWN_TOOL;
  }

  if (kind === 'schema') {
    deps.stdout(`${JSON.stringify(match.inputSchema, null, 2)}\n`);
    return EXIT_SUCCESS;
  }
  if (kind === 'example') {
    deps.stdout(`${JSON.stringify(generateExample(match.inputSchema), null, 2)}\n`);
    return EXIT_SUCCESS;
  }
  deps.stdout(renderDescribe(match, json));
  return EXIT_SUCCESS;
}
