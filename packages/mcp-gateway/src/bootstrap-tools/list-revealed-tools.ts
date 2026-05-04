import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import type { SessionVisibility } from '@toolbox/core';
import { z } from 'zod';

import { BOOTSTRAP_TOOL_NAMES, LIST_REVEALED_TOOLS_NAME } from './names.js';
import type { BootstrapTool } from './registry.js';

export { LIST_REVEALED_TOOLS_NAME };

/**
 * `toolbox__list_revealed_tools` (M4-05) — read-only inspection of the
 * current session's visible tool surface. Returns the bootstrap tools (which
 * are always visible) alongside the session-revealed exposed names so the
 * agent can see exactly what `tools/list` would surface today, without
 * re-issuing it. Never mutates session visibility.
 */

const ArgsSchema = z.object({}).strict();

const LIST_REVEALED_TOOLS_DESCRIPTOR: Tool = {
  name: LIST_REVEALED_TOOLS_NAME,
  title: 'List revealed ToolBox tools',
  description:
    'List every tool currently visible in the session: the always-on ToolBox bootstrap ' +
    'tools and any upstream tools that have been revealed via toolbox__reveal_tools. ' +
    'Read-only — does not change visibility. Use toolbox__search_tools to discover ' +
    'additional candidates and toolbox__hide_tools to remove names from this list.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

export interface CreateListRevealedToolsBootstrapDeps {
  /** Per-session visibility registry whose contents are reported. */
  visibility: SessionVisibility;
}

interface RevealedToolsLine {
  readonly kind: 'revealed-tools';
  readonly bootstrapTools: readonly string[];
  readonly revealed: readonly string[];
  readonly total: number;
}

export function createListRevealedToolsBootstrap(
  deps: CreateListRevealedToolsBootstrapDeps,
): BootstrapTool {
  const { visibility } = deps;
  // Snapshot the canonical bootstrap names once. They're a static module-level
  // constant in `names.ts` so this never goes stale within a session.
  const bootstrapTools = sortByByteOrder(BOOTSTRAP_TOOL_NAMES);

  return {
    descriptor: LIST_REVEALED_TOOLS_DESCRIPTOR,
    invoke(rawArgs) {
      const parsed = ArgsSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return invalidArgsResult(parsed.error.issues);
      }

      const revealed = visibility.list();

      const line: RevealedToolsLine = {
        kind: 'revealed-tools',
        bootstrapTools,
        revealed,
        total: bootstrapTools.length + revealed.length,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(line) }],
      };
    },
  };
}

function sortByByteOrder(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  });
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
        text: `invalid arguments to ${LIST_REVEALED_TOOLS_NAME}: ${message}`,
      },
    ],
  };
}
