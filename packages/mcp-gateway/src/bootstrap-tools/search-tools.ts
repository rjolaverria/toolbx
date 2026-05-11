import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  searchTools,
  type SearchMatchedField,
  type SessionVisibility,
  type ToolSearchResult,
} from '@toolbox/core';
import { z } from 'zod';

import type { ToolRegistry } from '../registry/index.js';

import { SEARCH_TOOLS_NAME } from './names.js';
import type { BootstrapTool, BootstrapToolRegistry } from './registry.js';

export { SEARCH_TOOLS_NAME };

/**
 * `toolbox__search_tools` (M4-03) — the first progressive-disclosure
 * bootstrap tool. Surfaces ranked candidate tools across every enabled
 * upstream server.
 *
 * When `progressiveDisclosure.autoRevealExactServerMatches` is `true` (the
 * shipped default) and the inbound query exactly matches an enabled server's
 * name (case-insensitive, post-trim), every tool exposed by that server is
 * added to the session's revealed set before the search response is built.
 * The response summary names which exposed tools were auto-revealed so the
 * caller doesn't have to follow up with `toolbox__reveal_tools`. The
 * `SessionVisibility.reveal()` call emits a single `change` event, which the
 * downstream-session debouncer in `notify-tools-changed.ts` collapses into
 * one `notifications/tools/list_changed`.
 *
 * The tool descriptor is hand-written JSON Schema (matches the existing
 * gateway pattern). A small local Zod schema validates the inbound
 * arguments at the IO boundary; the two are intentionally kept in sync
 * by hand because the surface area is three fields and there's no
 * value in pulling in a Zod-to-JSON-Schema converter.
 */

const ArgsSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().optional(),
    includeRevealed: z.boolean().optional(),
  })
  .strict();

const SEARCH_TOOLS_DESCRIPTOR: Tool = {
  name: SEARCH_TOOLS_NAME,
  title: 'Search ToolBox tools',
  description:
    'Search across every enabled upstream MCP server for tools matching a query. ' +
    'Returns ranked candidate tools without revealing them — use toolbox__reveal_tools ' +
    'to expose a match for direct invocation. Ranking is deterministic: server-name ' +
    'matches first, then exact tool-name, then description, then input-schema text, ' +
    'then fuzzy substring matches. Ties break alphabetically by exposed name.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description: 'Free-text query (server name, tool name, or keywords).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description:
          'Max candidates to return. Clamped server-side by the configured maxSearchResults.',
      },
      includeRevealed: {
        type: 'boolean',
        description: 'Reserved for use by toolbox__reveal_tools (M4-04). Currently has no effect.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export interface RegisterSearchToolsBootstrapDeps {
  /** Bootstrap registry to add the search tool to. */
  registry: BootstrapToolRegistry;
  /** Upstream tool registry searched on every invocation. */
  toolRegistry: ToolRegistry;
  /**
   * `progressiveDisclosure.maxSearchResults` from the loaded config — the
   * upper bound clamped against the caller-supplied `limit`.
   */
  maxSearchResults: number;
  /**
   * Per-session visibility used for the auto-reveal side effect. The search
   * tool only mutates it when `autoRevealExactServerMatches` is `true` AND
   * the query is an exact server-name match.
   */
  visibility: SessionVisibility;
  /**
   * Effective value of `progressiveDisclosure.autoRevealExactServerMatches`
   * after defaulting. Read from the merged config — never `?? false`.
   */
  autoRevealExactServerMatches: boolean;
}

/**
 * Register `toolbox__search_tools` with the given bootstrap registry. Caller
 * gates this on `progressiveDisclosure.bootstrapTools` from config.
 */
export function registerSearchToolsBootstrap(deps: RegisterSearchToolsBootstrapDeps): void {
  const { registry, toolRegistry, maxSearchResults, visibility, autoRevealExactServerMatches } =
    deps;

  const tool: BootstrapTool = {
    descriptor: SEARCH_TOOLS_DESCRIPTOR,
    invoke(rawArgs) {
      const parsed = ArgsSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return invalidArgsResult(parsed.error.issues);
      }

      const requestedLimit = parsed.data.limit ?? maxSearchResults;
      const effectiveLimit = Math.max(1, Math.min(requestedLimit, maxSearchResults));

      const tools = toolRegistry.list();
      const hits = searchTools(parsed.data.query, tools, { limit: effectiveLimit });

      // Auto-reveal runs against the full visible tool set (not the
      // ranked-and-clamped `hits`) so that a server with more than
      // `maxSearchResults` tools still reveals all of them on an exact match.
      const autoRevealed = autoRevealExactServerMatches
        ? autoRevealExactServerMatch(parsed.data.query, tools, visibility)
        : [];

      const content = hits.map((hit) => ({
        type: 'text' as const,
        text: JSON.stringify(formatCandidate(hit)),
      }));
      content.push({
        type: 'text' as const,
        text: JSON.stringify({
          kind: 'summary',
          query: parsed.data.query,
          returned: hits.length,
          limit: effectiveLimit,
          maxSearchResults,
          autoRevealed,
        }),
      });

      return { content };
    },
  };

  registry.add(tool);
}

/**
 * Returns the exposed names that were newly revealed by this call (empty if
 * the query did not exactly match an enabled server name, or if every tool
 * for the matched server was already visible). Comparison is
 * case-insensitive and ignores leading/trailing whitespace on the query;
 * server names are validated at config load to be ASCII so a simple lowercase
 * suffices.
 */
function autoRevealExactServerMatch(
  query: string,
  tools: readonly { readonly serverName: string; readonly exposedName: string }[],
  visibility: SessionVisibility,
): readonly string[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [];
  }
  const matchingTools: string[] = [];
  for (const tool of tools) {
    if (tool.serverName.toLowerCase() === normalized) {
      matchingTools.push(tool.exposedName);
    }
  }
  if (matchingTools.length === 0) {
    return [];
  }
  return visibility.reveal(matchingTools);
}

interface CandidateLine {
  readonly kind: 'candidate';
  readonly exposedName: string;
  readonly serverName: string;
  readonly upstreamName: string;
  readonly title?: string;
  readonly description?: string;
  readonly score: number;
  readonly matchedFields: readonly SearchMatchedField[];
  readonly inputSchemaExcerpt: SchemaExcerpt;
}

interface SchemaExcerpt {
  readonly properties: readonly { readonly name: string; readonly description?: string }[];
  readonly required: readonly string[];
}

function formatCandidate(hit: ToolSearchResult): CandidateLine {
  const { tool } = hit;
  const title = tool.tool.title;
  const description = tool.tool.description;
  return {
    kind: 'candidate',
    exposedName: tool.exposedName,
    serverName: tool.serverName,
    upstreamName: tool.upstreamName,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    score: hit.score,
    matchedFields: hit.matchedFields,
    inputSchemaExcerpt: excerptInputSchema(tool.tool.inputSchema),
  };
}

/**
 * Top-level-only excerpt of a tool's `inputSchema`. Lists property names
 * (with their `description` when present) plus the `required` array. Nested
 * schemas are intentionally omitted to keep the response compact — full
 * schemas are available through `tools/list` once a tool is revealed.
 */
function excerptInputSchema(schema: unknown): SchemaExcerpt {
  if (schema === null || typeof schema !== 'object') {
    return { properties: [], required: [] };
  }
  const node = schema as Record<string, unknown>;

  const rawProps = node.properties;
  const propsObj =
    rawProps !== null && typeof rawProps === 'object' && !Array.isArray(rawProps)
      ? (rawProps as Record<string, unknown>)
      : {};

  const properties: { readonly name: string; readonly description?: string }[] = [];
  for (const [name, value] of Object.entries(propsObj)) {
    const description =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).description
        : undefined;
    if (typeof description === 'string') {
      properties.push({ name, description });
    } else {
      properties.push({ name });
    }
  }

  const rawRequired = node.required;
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return { properties, required };
}

function invalidArgsResult(issues: readonly z.core.$ZodIssue[]): CallToolResult {
  const message = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `invalid arguments to ${SEARCH_TOOLS_NAME}: ${message}`,
      },
    ],
  };
}
