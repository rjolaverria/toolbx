import type { RegisteredToolView } from '../proxy/registry-view.js';

/**
 * Pure, deterministic tool search ranking. Powers `toolbx__search_tools`
 * (M4-03) and `tlbx tools search` (M5-02).
 *
 * Ranking follows SPECS §4.5 — strict bands evaluated top-down, first match
 * wins. Within a band, ties resolve alphabetically by `exposedName` using
 * byte-order comparison (mirrors the registry's locale-independent sort in
 * `@toolbx/mcp-gateway`'s `tool-registry.ts`). Embeddings, stemming, and
 * language-aware processing are out of scope for the MVP.
 */

const DEFAULT_LIMIT = 20;

const FIELD_ORDER: readonly SearchMatchedField[] = [
  'serverName',
  'exposedName',
  'toolName',
  'toolTitle',
  'description',
  'inputSchema',
  'tags',
];

export type SearchMatchedField =
  | 'serverName'
  | 'exposedName'
  | 'toolName'
  | 'toolTitle'
  | 'description'
  | 'inputSchema'
  | 'tags';

export interface ToolSearchResult {
  readonly tool: RegisteredToolView;
  readonly score: number;
  readonly matchedFields: readonly SearchMatchedField[];
}

export interface ToolSearchOptions {
  /**
   * Max results returned. Callers should pass
   * `progressiveDisclosure.maxSearchResults` from the loaded config; falls
   * back to 20 when omitted so the function is usable in isolation.
   */
  readonly limit?: number;
  /**
   * Optional per-tool tags keyed by exposed name. Tags are not part of the
   * config schema yet, so the search function takes them as a side-channel
   * input rather than coupling to a future config shape.
   */
  readonly tagsByExposedName?: Readonly<Record<string, readonly string[]>>;
}

interface IndexedTool {
  readonly tool: RegisteredToolView;
  readonly serverName: string;
  readonly exposedName: string;
  readonly toolName: string;
  readonly toolTitle: string;
  readonly description: string;
  readonly schemaText: string;
  readonly tags: readonly string[];
}

export function searchTools(
  query: string,
  tools: readonly RegisteredToolView[],
  options?: ToolSearchOptions,
): readonly ToolSearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [];
  }
  const tokens = tokenize(normalized);
  if (tokens.length === 0) {
    return [];
  }

  const indexed = tools.map((tool) => indexTool(tool, options?.tagsByExposedName));
  const results: ToolSearchResult[] = [];
  for (const entry of indexed) {
    const scored = scoreTool(entry, normalized, tokens);
    if (scored !== null) {
      results.push(scored);
    }
  }

  results.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.tool.exposedName === b.tool.exposedName) {
      return 0;
    }
    return a.tool.exposedName < b.tool.exposedName ? -1 : 1;
  });

  // Clamp to a non-negative integer so a caller-supplied limit cannot trigger
  // `Array.prototype.slice`'s negative-index behaviour (which returns
  // `length - n` items instead of an empty list) or fractional truncation.
  const rawLimit = options?.limit ?? DEFAULT_LIMIT;
  const limit = Math.max(0, Math.floor(rawLimit));
  return results.slice(0, limit);
}

function indexTool(
  tool: RegisteredToolView,
  tagsByExposedName: ToolSearchOptions['tagsByExposedName'],
): IndexedTool {
  const tags = tagsByExposedName?.[tool.exposedName] ?? [];
  return {
    tool,
    serverName: tool.serverName.toLowerCase(),
    exposedName: tool.exposedName.toLowerCase(),
    toolName: tool.upstreamName.toLowerCase(),
    toolTitle: (tool.tool.title ?? '').toLowerCase(),
    description: (tool.tool.description ?? '').toLowerCase(),
    schemaText: collectSchemaText(tool.tool.inputSchema),
    tags: tags.map((tag) => tag.toLowerCase()),
  };
}

function scoreTool(
  entry: IndexedTool,
  query: string,
  tokens: readonly string[],
): ToolSearchResult | null {
  // Band 1 — exact server match.
  if (entry.serverName === query) {
    return finalize(entry, 600, ['serverName']);
  }
  // Band 2 — exact exposed (namespace) match.
  if (entry.exposedName === query) {
    return finalize(entry, 500, ['exposedName']);
  }
  // Band 3 — exact tool name and/or title match.
  const band3: SearchMatchedField[] = [];
  if (entry.toolName === query) {
    band3.push('toolName');
  }
  if (entry.toolTitle.length > 0 && entry.toolTitle === query) {
    band3.push('toolTitle');
  }
  if (band3.length > 0) {
    return finalize(entry, 400, band3);
  }
  // Band 4 — every query token is a substring of description and/or any tag.
  const band4: SearchMatchedField[] = [];
  if (entry.description.length > 0 && tokens.every((t) => entry.description.includes(t))) {
    band4.push('description');
  }
  if (entry.tags.length > 0 && tokens.every((t) => entry.tags.some((tag) => tag.includes(t)))) {
    band4.push('tags');
  }
  if (band4.length > 0) {
    return finalize(entry, 300, band4);
  }
  // Band 5 — every query token is a substring of the input schema text.
  if (entry.schemaText.length > 0 && tokens.every((t) => entry.schemaText.includes(t))) {
    return finalize(entry, 200, ['inputSchema']);
  }
  // Band 6 — fuzzy: any single query token substring-matches any indexed
  // field. Captures partial matches that fell through the exact bands.
  const band6 = collectFuzzyMatches(entry, tokens);
  if (band6.length > 0) {
    return finalize(entry, 100, band6);
  }
  return null;
}

function collectFuzzyMatches(entry: IndexedTool, tokens: readonly string[]): SearchMatchedField[] {
  const hits = new Set<SearchMatchedField>();
  for (const token of tokens) {
    if (entry.serverName.includes(token)) {
      hits.add('serverName');
    }
    if (entry.exposedName.includes(token)) {
      hits.add('exposedName');
    }
    if (entry.toolName.includes(token)) {
      hits.add('toolName');
    }
    if (entry.toolTitle.length > 0 && entry.toolTitle.includes(token)) {
      hits.add('toolTitle');
    }
    if (entry.description.length > 0 && entry.description.includes(token)) {
      hits.add('description');
    }
    if (entry.schemaText.length > 0 && entry.schemaText.includes(token)) {
      hits.add('inputSchema');
    }
    if (entry.tags.some((tag) => tag.includes(token))) {
      hits.add('tags');
    }
  }
  return [...hits];
}

function finalize(
  entry: IndexedTool,
  score: number,
  matched: readonly SearchMatchedField[],
): ToolSearchResult {
  const unique = new Set(matched);
  const ordered = FIELD_ORDER.filter((field) => unique.has(field));
  return { tool: entry.tool, score, matchedFields: ordered };
}

function tokenize(text: string): string[] {
  return text.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

// Cap recursion to keep pathological / cyclic schemas bounded. JSON Schema
// nesting deeper than this in practice is exotic; the cap is a safety net,
// not a feature constraint.
const SCHEMA_MAX_DEPTH = 8;

function collectSchemaText(schema: unknown): string {
  const parts: string[] = [];
  walkSchema(schema, parts, 0);
  return parts.join(' ');
}

function walkSchema(schema: unknown, parts: string[], depth: number): void {
  if (depth > SCHEMA_MAX_DEPTH || schema === null || typeof schema !== 'object') {
    return;
  }
  const node = schema as Record<string, unknown>;

  if (typeof node.description === 'string') {
    parts.push(node.description.toLowerCase());
  }

  const properties = node.properties;
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
      parts.push(name.toLowerCase());
      walkSchema(value, parts, depth + 1);
    }
  }

  const items = node.items;
  if (Array.isArray(items)) {
    for (const child of items) {
      walkSchema(child, parts, depth + 1);
    }
  } else if (items !== undefined) {
    walkSchema(items, parts, depth + 1);
  }

  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branch = node[key];
    if (Array.isArray(branch)) {
      for (const child of branch) {
        walkSchema(child, parts, depth + 1);
      }
    }
  }
}
