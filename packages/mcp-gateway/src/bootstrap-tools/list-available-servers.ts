import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import type { ServerStatus, ServerStatusEntry, StatusRegistry } from '@toolbox/core';
import { z } from 'zod';

import { LIST_AVAILABLE_SERVERS_NAME } from './names.js';
import type { BootstrapTool } from './registry.js';

export { LIST_AVAILABLE_SERVERS_NAME };

/**
 * `toolbox__list_available_servers` (M4-05) — read-only introspection over
 * the M1-04 status registry. Lets an agent see which upstream servers are
 * configured and which are currently usable without revealing any tools.
 *
 * Disabled servers are skipped by default; pass `{ includeDisabled: true }`
 * to surface them too. The tool never mutates registry state — it reads
 * `StatusRegistry.list()` on every call so the response reflects whatever
 * the connection manager has reported up to that moment.
 */

const ArgsSchema = z
  .object({
    includeDisabled: z.boolean().optional(),
  })
  .strict();

const LIST_AVAILABLE_SERVERS_DESCRIPTOR: Tool = {
  name: LIST_AVAILABLE_SERVERS_NAME,
  title: 'List available ToolBox servers',
  description:
    'List every upstream MCP server ToolBox is configured to talk to, with its transport, ' +
    'enabled flag, current connection status, and the number of tools it currently exposes. ' +
    'Disabled servers are omitted unless includeDisabled is true. Use ' +
    'toolbox__search_tools to find specific tools across these servers.',
  inputSchema: {
    type: 'object',
    properties: {
      includeDisabled: {
        type: 'boolean',
        description: 'When true, also return servers whose enabled flag is false.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export interface CreateListAvailableServersBootstrapDeps {
  /** Source of live server status, transport, and tool counts. */
  statusRegistry: StatusRegistry;
}

interface ServerSummary {
  readonly name: string;
  readonly type: 'stdio' | 'http';
  readonly enabled: boolean;
  readonly status: StatusSummary;
  readonly toolCount: number;
}

type StatusSummary =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'starting'; readonly attempt: number }
  | { readonly kind: 'connected'; readonly since: string }
  | { readonly kind: 'auth_required'; readonly reason: string }
  | { readonly kind: 'auth_expired'; readonly reason: string }
  | {
      readonly kind: 'error';
      readonly error: string;
      readonly nextRetryAt: string | null;
    }
  | { readonly kind: 'stopped' };

interface ServersListLine {
  readonly kind: 'available-servers';
  readonly servers: readonly ServerSummary[];
  readonly returned: number;
  readonly total: number;
  readonly includeDisabled: boolean;
}

export function createListAvailableServersBootstrap(
  deps: CreateListAvailableServersBootstrapDeps,
): BootstrapTool {
  const { statusRegistry } = deps;

  return {
    descriptor: LIST_AVAILABLE_SERVERS_DESCRIPTOR,
    invoke(rawArgs) {
      const parsed = ArgsSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return invalidArgsResult(parsed.error.issues);
      }

      const includeDisabled = parsed.data.includeDisabled ?? false;
      const all = statusRegistry.list();
      const visible = includeDisabled ? all : all.filter((entry) => entry.enabled);

      const servers = visible.map(toSummary);

      const line: ServersListLine = {
        kind: 'available-servers',
        servers,
        returned: servers.length,
        total: all.length,
        includeDisabled,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(line) }],
      };
    },
  };
}

function toSummary(entry: ServerStatusEntry): ServerSummary {
  return {
    name: entry.name,
    type: entry.transport,
    enabled: entry.enabled,
    status: serializeStatus(entry.status),
    toolCount: entry.toolCount,
  };
}

function serializeStatus(status: ServerStatus): StatusSummary {
  switch (status.kind) {
    case 'disabled':
      return { kind: 'disabled' };
    case 'stopped':
      return { kind: 'stopped' };
    case 'starting':
      return { kind: 'starting', attempt: status.attempt };
    case 'connected':
      return { kind: 'connected', since: status.since.toISOString() };
    case 'auth_required':
      return { kind: 'auth_required', reason: status.reason };
    case 'auth_expired':
      return { kind: 'auth_expired', reason: status.reason };
    case 'error':
      return {
        kind: 'error',
        error: status.error.message,
        nextRetryAt: status.nextRetryAt === null ? null : status.nextRetryAt.toISOString(),
      };
  }
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
        text: `invalid arguments to ${LIST_AVAILABLE_SERVERS_NAME}: ${message}`,
      },
    ],
  };
}
