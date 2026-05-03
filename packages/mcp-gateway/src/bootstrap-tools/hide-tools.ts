import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import type { SessionVisibility } from '@toolbox/core';
import { z } from 'zod';

import { BOOTSTRAP_TOOL_NAMES, HIDE_TOOLS_NAME } from './names.js';
import type { BootstrapTool } from './registry.js';

export { HIDE_TOOLS_NAME };

/**
 * `toolbox__hide_tools` (M4-04) — removes exposed names from the session's
 * revealed set. Bootstrap tools cannot be hidden; passing one is a hard error
 * that does not mutate state. Names that aren't currently revealed (or aren't
 * known at all) are pass-through no-ops in line with `SessionVisibility.hide`.
 */

const ArgsSchema = z
  .object({
    tools: z.array(z.string().min(1)).min(1),
  })
  .strict();

const HIDE_TOOLS_DESCRIPTOR: Tool = {
  name: HIDE_TOOLS_NAME,
  title: 'Hide Toolbox tools',
  description:
    'Remove one or more exposed (namespaced) tools from the current session so they no ' +
    'longer appear in tools/list. Bootstrap tools cannot be hidden. Names that are not ' +
    'currently revealed are silently skipped and reported back as notVisible.',
  inputSchema: {
    type: 'object',
    properties: {
      tools: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'string',
          minLength: 1,
        },
        description: 'One or more exposed tool names to hide from the current session.',
      },
    },
    required: ['tools'],
    additionalProperties: false,
  },
};

export interface CreateHideToolsBootstrapDeps {
  /** Per-session visibility registry the hide mutates. */
  visibility: SessionVisibility;
}

interface HideResultLine {
  readonly kind: 'hide-result';
  readonly hidden: readonly string[];
  readonly notVisible: readonly string[];
  readonly visibleCount: number;
}

export function createHideToolsBootstrap(deps: CreateHideToolsBootstrapDeps): BootstrapTool {
  const { visibility } = deps;
  const bootstrapNameSet = new Set(BOOTSTRAP_TOOL_NAMES);

  return {
    descriptor: HIDE_TOOLS_DESCRIPTOR,
    invoke(rawArgs) {
      const parsed = ArgsSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return invalidArgsResult(parsed.error.issues);
      }

      const requested = sortByByteOrder(new Set(parsed.data.tools));
      const bootstrap = requested.filter((name) => bootstrapNameSet.has(name));
      if (bootstrap.length > 0) {
        return errorResult(`cannot hide bootstrap tools: ${bootstrap.join(', ')}`);
      }

      const removed = visibility.hide(requested);
      const removedSet = new Set(removed);
      const notVisible = requested.filter((name) => !removedSet.has(name));

      const line: HideResultLine = {
        kind: 'hide-result',
        hidden: sortByByteOrder(removed),
        notVisible,
        visibleCount: visibility.list().length,
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
        text: `invalid arguments to ${HIDE_TOOLS_NAME}: ${message}`,
      },
    ],
  };
}

function errorResult(text: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
