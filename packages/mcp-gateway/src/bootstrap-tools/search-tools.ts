import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { searchTools, type SearchMatchedField, type ToolSearchResult } from '@toolbox/core';
import { z } from 'zod';

import type { ToolRegistry } from '../registry/index.js';

import { SEARCH_TOOLS_NAME } from './names.js';
import type { BootstrapTool, BootstrapToolRegistry } from './registry.js';

export { SEARCH_TOOLS_NAME };

/**
 * `toolbox__search_tools` (M4-03) — the first progressive-disclosure
 * bootstrap tool. Surfaces ranked candidate tools across every enabled
 * upstream server without revealing them; reveal/hide is M4-04's job.
 *
 * `progressiveDisclosure.autoRevealExactServerMatches` exists in config but
 * is intentionally NOT honoured here yet — the M4-03 task explicitly defers
 * any visibility mutation to M4-04 (`toolbox__reveal_tools`). Once that
 * lands, this file will accept a `SessionVisibility` and call
 * `visibility.reveal(serverTools)` when the query exactly matches a server
 * name AND the flag is set. The header note in
 * `packages/core/src/disclosure/session-visibility.ts` describes that future
 * wiring; it does not describe current behaviour.
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
}

/**
 * Register `toolbox__search_tools` with the given bootstrap registry. Caller
 * gates this on `progressiveDisclosure.bootstrapTools` from config.
 */
export function registerSearchToolsBootstrap(deps: RegisterSearchToolsBootstrapDeps): void {
  const { registry, toolRegistry, maxSearchResults } = deps;

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
        }),
      });

      return { content };
    },
  };

  registry.add(tool);
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
