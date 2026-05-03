import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import type { SessionVisibility } from '@toolbox/core';
import { z } from 'zod';

import type { ToolRegistry } from '../registry/index.js';

import { BOOTSTRAP_TOOL_NAMES, REVEAL_TOOLS_NAME } from './names.js';
import type { BootstrapTool } from './registry.js';

export { REVEAL_TOOLS_NAME };

/**
 * `toolbox__reveal_tools` (M4-04) — adds exposed names to the session's
 * revealed set so they appear in the next `tools/list` (once M4-07 wires
 * `tools/list` through `SessionVisibility`).
 *
 * Validation is all-or-nothing: every requested name must be a known
 * upstream tool and must NOT be a bootstrap tool. If any input fails either
 * check, no `visibility.reveal()` call happens.
 */

const ArgsSchema = z
  .object({
    tools: z.array(z.string().min(1)).min(1),
  })
  .strict();

const REVEAL_TOOLS_DESCRIPTOR: Tool = {
  name: REVEAL_TOOLS_NAME,
  title: 'Reveal Toolbox tools',
  description:
    'Add one or more exposed (namespaced) tools to the current session so they appear in ' +
    'subsequent tools/list responses and become callable via tools/call. Use ' +
    'toolbox__search_tools to discover candidate names. Bootstrap tools cannot be revealed ' +
    '(they are always visible) and unknown names are rejected without mutating state.',
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
        description: 'One or more exposed tool names (e.g. "jira__search_issues") to mark visible.',
      },
    },
    required: ['tools'],
    additionalProperties: false,
  },
};

export interface CreateRevealToolsBootstrapDeps {
  /** Per-session visibility registry the reveal mutates. */
  visibility: SessionVisibility;
  /** Upstream tool registry consulted to validate that requested names exist. */
  toolRegistry: ToolRegistry;
}

interface RevealResultLine {
  readonly kind: 'reveal-result';
  readonly revealed: readonly string[];
  readonly alreadyVisible: readonly string[];
  readonly visibleCount: number;
}

export function createRevealToolsBootstrap(deps: CreateRevealToolsBootstrapDeps): BootstrapTool {
  const { visibility, toolRegistry } = deps;
  const bootstrapNameSet = new Set(BOOTSTRAP_TOOL_NAMES);

  return {
    descriptor: REVEAL_TOOLS_DESCRIPTOR,
    invoke(rawArgs) {
      const parsed = ArgsSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return invalidArgsResult(parsed.error.issues);
      }

      const requested = sortByByteOrder(new Set(parsed.data.tools));
      const bootstrap: string[] = [];
      const unknown: string[] = [];
      const valid: string[] = [];
      for (const name of requested) {
        if (bootstrapNameSet.has(name)) {
          bootstrap.push(name);
        } else if (toolRegistry.find(name) === undefined) {
          unknown.push(name);
        } else {
          valid.push(name);
        }
      }

      if (bootstrap.length > 0) {
        return errorResult(`cannot reveal bootstrap tools: ${bootstrap.join(', ')}`);
      }
      if (unknown.length > 0) {
        return errorResult(`unknown tools: ${unknown.join(', ')}`);
      }

      const added = visibility.reveal(valid);
      const addedSet = new Set(added);
      const alreadyVisible = valid.filter((name) => !addedSet.has(name));

      const line: RevealResultLine = {
        kind: 'reveal-result',
        revealed: sortByByteOrder(added),
        alreadyVisible,
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
        text: `invalid arguments to ${REVEAL_TOOLS_NAME}: ${message}`,
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
