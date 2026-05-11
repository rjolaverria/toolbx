import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { createNoopLogger, createSessionVisibility, ToolBoxConfigSchema } from '@toolbox/core';
import type { NamespaceOptions, ServerStatus, SessionVisibility } from '@toolbox/core';
import { describe, expect, it } from 'vitest';

import { registerToolsCallHandler } from '../../downstream-server/handlers/tools-call.js';
import { registerToolsListHandler } from '../../downstream-server/handlers/tools-list.js';
import { buildToolBoxMcpServer } from '../../downstream-server/server.js';
import { createToolRegistry, type ToolRegistry } from '../../registry/index.js';
import type { UpstreamSessionLookup } from '../../downstream-server/handlers/index.js';
import { createBootstrapToolRegistry, type BootstrapToolRegistry } from '../registry.js';
import { registerSearchToolsBootstrap, SEARCH_TOOLS_NAME } from '../search-tools.js';

const NS: NamespaceOptions = { separator: '__', format: 'server__tool' };
const CONNECTED: ServerStatus = { kind: 'connected', since: new Date('2026-01-01T00:00:00Z') };

interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

interface CandidateLine {
  readonly kind: 'candidate';
  readonly exposedName: string;
  readonly serverName: string;
  readonly upstreamName: string;
  readonly title?: string;
  readonly description?: string;
  readonly score: number;
  readonly matchedFields: readonly string[];
  readonly inputSchemaExcerpt: {
    readonly properties: readonly { readonly name: string; readonly description?: string }[];
    readonly required: readonly string[];
  };
}

interface SummaryLine {
  readonly kind: 'summary';
  readonly query: string;
  readonly returned: number;
  readonly limit: number;
  readonly maxSearchResults: number;
  readonly autoRevealed: readonly string[];
}

function noopVisibility(): SessionVisibility {
  return createSessionVisibility({ mode: 'session' });
}

function tool(
  name: string,
  options: { description?: string; properties?: Record<string, { description?: string }> } = {},
): Tool {
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const [propName, propMeta] of Object.entries(options.properties ?? {})) {
    properties[propName] =
      propMeta.description !== undefined
        ? { type: 'string', description: propMeta.description }
        : { type: 'string' };
  }
  return {
    name,
    ...(options.description !== undefined ? { description: options.description } : {}),
    inputSchema: { type: 'object' as const, properties, required: [] },
  };
}

const NOOP_UPSTREAMS: UpstreamSessionLookup = { get: () => undefined };

interface ConnectOpts {
  registry: ToolRegistry;
  bootstrap: BootstrapToolRegistry;
  upstreams?: UpstreamSessionLookup;
  /**
   * When provided alongside `disclosureEnabled: true`, `tools/list` filters
   * upstream tools through this visibility so tests can assert that an
   * auto-reveal makes the revealed names appear on the next `tools/list`.
   */
  visibility?: SessionVisibility;
  disclosureEnabled?: boolean;
}

async function connect(
  opts: ConnectOpts,
): Promise<{ client: Client; closeAll: () => Promise<void> }> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const built = buildToolBoxMcpServer({
    logger: createNoopLogger(),
    sessionId: 'search-tools-test',
    registerHandlers: (server, session) => {
      const listOptions =
        opts.visibility !== undefined
          ? {
              visibility: opts.visibility,
              isDisclosureEnabled: (): boolean => opts.disclosureEnabled === true,
            }
          : {};
      registerToolsListHandler(server, session, opts.registry, opts.bootstrap, listOptions);
      registerToolsCallHandler(server, session, opts.registry, opts.upstreams ?? NOOP_UPSTREAMS, {
        namespacing: NS,
        bootstrap: opts.bootstrap,
      });
    },
  });
  await built.server.connect(serverTransport);

  const client = new Client(
    { name: 'toolbox-search-tools-test-client', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    client,
    closeAll: async () => {
      await client.close();
      await built.server.close();
    },
  };
}

function parseLines(result: CallToolResult): {
  candidates: CandidateLine[];
  summary: SummaryLine;
} {
  const blocks = result.content as TextBlock[];
  const parsed = blocks.map((b) => JSON.parse(b.text) as CandidateLine | SummaryLine);
  const summary = parsed[parsed.length - 1];
  if (summary === undefined || summary.kind !== 'summary') {
    throw new Error('expected last block to be a summary');
  }
  const candidates = parsed.slice(0, -1).filter((p): p is CandidateLine => p.kind === 'candidate');
  return { candidates, summary };
}

describe('toolbox__search_tools (M4-03)', () => {
  it('appears in tools/list when registered', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility: noopVisibility(),
      autoRevealExactServerMatches: false,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = await client.listTools();
    const search = result.tools.find((t) => t.name === SEARCH_TOOLS_NAME);
    expect(search).toBeDefined();
    expect(search?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        includeRevealed: { type: 'boolean' },
      },
      required: ['query'],
    });
    await closeAll();
  });

  it('is absent from tools/list when bootstrap registry is empty', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const bootstrap = createBootstrapToolRegistry();

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = await client.listTools();
    expect(result.tools.find((t) => t.name === SEARCH_TOOLS_NAME)).toBeUndefined();
    expect(result.tools.map((t) => t.name)).toEqual(['jira__search_issues']);
    await closeAll();
  });

  it('ranks an exact server-name query above all other matches', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues'), tool('create_issue'), tool('add_comment')],
    });
    registry.setServerEntry({
      serverName: 'github',
      status: CONNECTED,
      enabled: true,
      tools: [tool('create_pull_request'), tool('list_issues')],
    });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility: noopVisibility(),
      autoRevealExactServerMatches: false,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'jira' },
    })) as CallToolResult;
    const { candidates, summary } = parseLines(result);

    // The jira server has 3 tools — they all have score 600 (band 1 — server
    // match) and tie-break alphabetically. Anything else is a fuzzy hit at
    // most, so jira tools must come first.
    expect(candidates.slice(0, 3).map((c) => c.serverName)).toEqual(['jira', 'jira', 'jira']);
    expect(candidates[0]?.matchedFields).toContain('serverName');
    expect(summary).toMatchObject({ kind: 'summary', query: 'jira', maxSearchResults: 20 });
    await closeAll();
  });

  it('returns the documented candidate shape with title, description, and schema excerpt', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [
        {
          name: 'search_issues',
          title: 'Search Issues',
          description: 'Run a JQL query',
          inputSchema: {
            type: 'object',
            properties: {
              jql: { type: 'string', description: 'JQL query string' },
              fields: { type: 'array', items: { type: 'string' } },
            },
            required: ['jql'],
          },
        },
      ],
    });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility: noopVisibility(),
      autoRevealExactServerMatches: false,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'jql' },
    })) as CallToolResult;
    const { candidates } = parseLines(result);

    expect(candidates).toHaveLength(1);
    const [hit] = candidates;
    expect(hit).toMatchObject({
      kind: 'candidate',
      exposedName: 'jira__search_issues',
      serverName: 'jira',
      upstreamName: 'search_issues',
      title: 'Search Issues',
      description: 'Run a JQL query',
      inputSchemaExcerpt: {
        properties: [{ name: 'jql', description: 'JQL query string' }, { name: 'fields' }],
        required: ['jql'],
      },
    });
    expect(typeof hit?.score).toBe('number');
    expect(Array.isArray(hit?.matchedFields)).toBe(true);
    await closeAll();
  });

  it('clamps the caller-supplied limit by maxSearchResults', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('a'), tool('b'), tool('c'), tool('d'), tool('e')],
    });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 2,
      visibility: noopVisibility(),
      autoRevealExactServerMatches: false,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'jira', limit: 100 },
    })) as CallToolResult;
    const { candidates, summary } = parseLines(result);

    expect(candidates).toHaveLength(2);
    expect(summary).toMatchObject({ returned: 2, limit: 2, maxSearchResults: 2 });
    await closeAll();
  });

  it('returns zero candidates plus a summary for a query that matches nothing', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility: noopVisibility(),
      autoRevealExactServerMatches: false,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'this-matches-nothing-xyzzy' },
    })) as CallToolResult;
    const { candidates, summary } = parseLines(result);

    expect(candidates).toEqual([]);
    expect(summary.returned).toBe(0);
    await closeAll();
  });

  it('returns isError on invalid arguments without throwing an McpError', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility: noopVisibility(),
      autoRevealExactServerMatches: false,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 123 },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const block = (result.content as TextBlock[])[0];
    expect(block?.text).toContain('invalid arguments');
    await closeAll();
  });

  it('does not mutate the upstream tool registry while searching', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues'), tool('create_issue')],
    });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility: noopVisibility(),
      autoRevealExactServerMatches: false,
    });

    const beforeSnapshot = registry.list().map((e) => e.exposedName);
    let notifications = 0;
    const unsubscribe = registry.subscribe(() => {
      notifications += 1;
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    await client.callTool({ name: SEARCH_TOOLS_NAME, arguments: { query: 'jira' } });
    await client.callTool({ name: SEARCH_TOOLS_NAME, arguments: { query: 'create_issue' } });

    expect(notifications).toBe(0);
    expect(registry.list().map((e) => e.exposedName)).toEqual(beforeSnapshot);

    unsubscribe();
    await closeAll();
  });

  it('emits a top-level-only schema excerpt and ignores nested properties', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [
        {
          name: 'nested',
          inputSchema: {
            type: 'object',
            properties: {
              outer: {
                type: 'object',
                description: 'wrapper',
                properties: { inner: { type: 'string', description: 'should not appear' } },
              },
            },
            required: [],
          },
        },
      ],
    });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility: noopVisibility(),
      autoRevealExactServerMatches: false,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'nested' },
    })) as CallToolResult;
    const { candidates } = parseLines(result);

    expect(candidates[0]?.inputSchemaExcerpt.properties).toEqual([
      { name: 'outer', description: 'wrapper' },
    ]);
    await closeAll();
  });
});

describe('toolbox__search_tools auto-reveal (F1-02)', () => {
  function populatedRegistry(): ToolRegistry {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues'), tool('create_issue'), tool('add_comment')],
    });
    registry.setServerEntry({
      serverName: 'github',
      status: CONNECTED,
      enabled: true,
      tools: [tool('create_pull_request'), tool('list_issues')],
    });
    return registry;
  }

  it('reveals every tool of an exactly-matched server when the flag is true', async () => {
    const registry = populatedRegistry();
    const visibility = createSessionVisibility({ mode: 'session' });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility,
      autoRevealExactServerMatches: true,
    });

    const { client, closeAll } = await connect({
      registry,
      bootstrap,
      visibility,
      disclosureEnabled: true,
    });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'jira' },
    })) as CallToolResult;
    const { summary } = parseLines(result);

    expect([...summary.autoRevealed].sort()).toEqual([
      'jira__add_comment',
      'jira__create_issue',
      'jira__search_issues',
    ]);
    expect(visibility.list()).toEqual([
      'jira__add_comment',
      'jira__create_issue',
      'jira__search_issues',
    ]);

    // The next tools/list from the same session must surface the
    // auto-revealed names.
    const listed = await client.listTools();
    const upstreamNames = listed.tools
      .map((t) => t.name)
      .filter((name) => name.startsWith('jira__'));
    expect(upstreamNames.sort()).toEqual([
      'jira__add_comment',
      'jira__create_issue',
      'jira__search_issues',
    ]);
    await closeAll();
  });

  it('matches server names case-insensitively after trimming whitespace', async () => {
    const registry = populatedRegistry();
    const visibility = createSessionVisibility({ mode: 'session' });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility,
      autoRevealExactServerMatches: true,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: '  JIRA  ' },
    })) as CallToolResult;
    const { summary } = parseLines(result);

    expect(summary.autoRevealed.length).toBe(3);
    expect(visibility.list().length).toBe(3);
    await closeAll();
  });

  it('does not auto-reveal on a partial server-name match when the flag is true', async () => {
    const registry = populatedRegistry();
    const visibility = createSessionVisibility({ mode: 'session' });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility,
      autoRevealExactServerMatches: true,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'jir' },
    })) as CallToolResult;
    const { summary } = parseLines(result);

    expect(summary.autoRevealed).toEqual([]);
    expect(visibility.list()).toEqual([]);
    await closeAll();
  });

  it('does not auto-reveal on an exact server-name match when the flag is false', async () => {
    const registry = populatedRegistry();
    const visibility = createSessionVisibility({ mode: 'session' });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility,
      autoRevealExactServerMatches: false,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'jira' },
    })) as CallToolResult;
    const { summary } = parseLines(result);

    expect(summary.autoRevealed).toEqual([]);
    expect(visibility.list()).toEqual([]);
    await closeAll();
  });

  it('does not auto-reveal on a partial server-name match when the flag is false', async () => {
    const registry = populatedRegistry();
    const visibility = createSessionVisibility({ mode: 'session' });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility,
      autoRevealExactServerMatches: false,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'jir' },
    })) as CallToolResult;
    const { summary } = parseLines(result);

    expect(summary.autoRevealed).toEqual([]);
    expect(visibility.list()).toEqual([]);
    await closeAll();
  });

  it('uses the schema default (true) when the user config omits the flag', async () => {
    // Round-trips through the config schema to prove the "unset in user
    // config" cell of the matrix resolves to auto-reveal on. Building the
    // full config inline keeps the test self-contained.
    const parsed = ToolBoxConfigSchema.parse({
      version: 1,
      server: {
        stdio: { enabled: true },
        http: { enabled: true, host: '127.0.0.1', port: 7331, path: '/mcp' },
      },
      progressiveDisclosure: {
        enabled: true,
        mode: 'session',
        bootstrapTools: true,
        // autoRevealExactServerMatches intentionally omitted.
        maxSearchResults: 20,
      },
      namespacing: { format: 'server__tool', collisionStrategy: 'error' },
      servers: {},
    });
    expect(parsed.progressiveDisclosure.autoRevealExactServerMatches).toBe(true);

    const registry = populatedRegistry();
    const visibility = createSessionVisibility({ mode: 'session' });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility,
      autoRevealExactServerMatches: parsed.progressiveDisclosure.autoRevealExactServerMatches,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'jira' },
    })) as CallToolResult;
    const { summary } = parseLines(result);

    expect(summary.autoRevealed.length).toBe(3);
    expect(visibility.list().length).toBe(3);
    await closeAll();
  });

  it('emits exactly one visibility change event per auto-reveal even when several tools are revealed', async () => {
    const registry = populatedRegistry();
    const visibility = createSessionVisibility({ mode: 'session' });
    let changeEvents = 0;
    const unsubscribe = visibility.on('change', () => {
      changeEvents += 1;
    });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility,
      autoRevealExactServerMatches: true,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    await client.callTool({ name: SEARCH_TOOLS_NAME, arguments: { query: 'jira' } });

    expect(changeEvents).toBe(1);

    // A second call with the same exact match must not re-emit because every
    // tool is already revealed.
    await client.callTool({ name: SEARCH_TOOLS_NAME, arguments: { query: 'jira' } });
    expect(changeEvents).toBe(1);

    unsubscribe();
    await closeAll();
  });

  it('does not auto-reveal tools from a disabled or disconnected server', async () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: { kind: 'disabled' },
      enabled: false,
      tools: [tool('search_issues'), tool('create_issue')],
    });
    const visibility = createSessionVisibility({ mode: 'session' });
    const bootstrap = createBootstrapToolRegistry();
    registerSearchToolsBootstrap({
      registry: bootstrap,
      toolRegistry: registry,
      maxSearchResults: 20,
      visibility,
      autoRevealExactServerMatches: true,
    });

    const { client, closeAll } = await connect({ registry, bootstrap });
    const result = (await client.callTool({
      name: SEARCH_TOOLS_NAME,
      arguments: { query: 'jira' },
    })) as CallToolResult;
    const { summary } = parseLines(result);

    expect(summary.autoRevealed).toEqual([]);
    expect(visibility.list()).toEqual([]);
    await closeAll();
  });
});
