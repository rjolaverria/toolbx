import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import type { NamespaceOptions } from '../../namespace/index.js';
import type { ServerStatus, ServerStatusKind } from '../../server-status/types.js';
import type { RegisteredToolView, RegistryView } from '../registry-view.js';
import { routeToolCall } from '../route.js';
import type { SessionCallToolOptions, SessionLookup, SessionView } from '../session-view.js';

const NS: NamespaceOptions = { separator: '__', format: 'server__tool' };
const CONNECTED: ServerStatus = { kind: 'connected', since: new Date('2026-01-01T00:00:00Z') };

function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  };
}

function entry(serverName: string, upstreamName: string): RegisteredToolView {
  return {
    exposedName: `${serverName}__${upstreamName}`,
    serverName,
    upstreamName,
    tool: tool(`${serverName}__${upstreamName}`),
  };
}

function makeRegistry(entries: readonly RegisteredToolView[]): RegistryView {
  const map = new Map(entries.map((e) => [e.exposedName, e]));
  return { find: (name) => map.get(name) };
}

interface RecordingSession extends SessionView {
  readonly calls: ReadonlyArray<{
    name: string;
    args: Record<string, unknown> | undefined;
    opts: SessionCallToolOptions | undefined;
  }>;
}

function makeSession(opts: {
  status?: ServerStatus;
  result?: CallToolResult;
  throwValue?: unknown;
}): RecordingSession {
  const calls: Array<{
    name: string;
    args: Record<string, unknown> | undefined;
    opts: SessionCallToolOptions | undefined;
  }> = [];
  const hasThrow = 'throwValue' in opts;
  return {
    status: opts.status ?? CONNECTED,
    calls,
    // eslint-disable-next-line @typescript-eslint/require-await
    async callTool(name, args, callOpts) {
      calls.push({ name, args, opts: callOpts });
      if (hasThrow) {
        throw opts.throwValue as Error;
      }
      return opts.result ?? { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

function makeSessions(map: Record<string, SessionView>): SessionLookup {
  return {
    get: (name) => map[name],
  };
}

describe('routeToolCall', () => {
  it('returns ok and forwards the upstream tool name + args on a successful call', async () => {
    const jiraEntry = entry('jira', 'search');
    const registry = makeRegistry([jiraEntry]);
    const upstreamResult: CallToolResult = {
      content: [{ type: 'text', text: 'found' }],
      structuredContent: { hits: 2 },
    };
    const jira = makeSession({ result: upstreamResult });

    const result = await routeToolCall({
      exposedName: 'jira__search',
      args: { jql: 'x' },
      registry,
      sessions: makeSessions({ jira }),
      namespacing: NS,
    });

    expect(result).toEqual({ kind: 'ok', result: upstreamResult });
    expect(jira.calls).toEqual([{ name: 'search', args: { jql: 'x' }, opts: undefined }]);
  });

  it('passes the abort signal through to the upstream session when provided', async () => {
    const jiraEntry = entry('jira', 'search');
    const registry = makeRegistry([jiraEntry]);
    const jira = makeSession({});
    const ac = new AbortController();

    await routeToolCall({
      exposedName: 'jira__search',
      args: undefined,
      registry,
      sessions: makeSessions({ jira }),
      namespacing: NS,
      signal: ac.signal,
    });

    expect(jira.calls).toHaveLength(1);
    expect(jira.calls[0]?.opts).toEqual({ signal: ac.signal });
  });

  it('treats undefined args as a valid empty call (does not flag invalid_args)', async () => {
    const jiraEntry = entry('jira', 'search');
    const registry = makeRegistry([jiraEntry]);
    const jira = makeSession({});

    const result = await routeToolCall({
      exposedName: 'jira__search',
      args: undefined,
      registry,
      sessions: makeSessions({ jira }),
      namespacing: NS,
    });

    expect(result.kind).toBe('ok');
    expect(jira.calls).toEqual([{ name: 'search', args: undefined, opts: undefined }]);
  });

  it('returns unknown_tool when the exposed name cannot be parsed', async () => {
    const result = await routeToolCall({
      exposedName: 'no-separator-here',
      args: undefined,
      registry: makeRegistry([]),
      sessions: makeSessions({}),
      namespacing: NS,
    });

    expect(result).toEqual({ kind: 'unknown_tool' });
  });

  it('returns unknown_tool when neither registry nor sessions know the server', async () => {
    const result = await routeToolCall({
      exposedName: 'ghost__tool',
      args: undefined,
      registry: makeRegistry([]),
      sessions: makeSessions({}),
      namespacing: NS,
    });

    expect(result).toEqual({ kind: 'unknown_tool' });
  });

  it('returns unknown_tool when the server is connected but the tool is absent', async () => {
    const ghost = makeSession({});
    const result = await routeToolCall({
      exposedName: 'ghost__missing',
      args: undefined,
      registry: makeRegistry([]),
      sessions: makeSessions({ ghost }),
      namespacing: NS,
    });

    expect(result).toEqual({ kind: 'unknown_tool' });
    expect(ghost.calls).toEqual([]);
  });

  it.each<[ServerStatusKind, ServerStatus]>([
    ['disabled', { kind: 'disabled' }],
    ['starting', { kind: 'starting', attempt: 1 }],
    ['error', { kind: 'error', error: new Error('boom'), nextRetryAt: null }],
    ['auth_required', { kind: 'auth_required', reason: 'login required' }],
    ['auth_expired', { kind: 'auth_expired', reason: 'token expired' }],
    ['stopped', { kind: 'stopped' }],
  ])(
    'returns server_unavailable with the live status when the server is %s',
    async (_label, status) => {
      const jira = makeSession({ status });
      const result = await routeToolCall({
        exposedName: 'jira__search',
        args: undefined,
        registry: makeRegistry([]),
        sessions: makeSessions({ jira }),
        namespacing: NS,
      });

      expect(result).toEqual({ kind: 'server_unavailable', server: 'jira', status });
      expect(jira.calls).toEqual([]);
    },
  );

  it('returns server_unavailable when the registry hit but the session has flipped off connected', async () => {
    const jiraEntry = entry('jira', 'search');
    const registry = makeRegistry([jiraEntry]);
    const errored: ServerStatus = {
      kind: 'error',
      error: new Error('lost connection'),
      nextRetryAt: null,
    };
    const jira = makeSession({ status: errored });

    const result = await routeToolCall({
      exposedName: 'jira__search',
      args: { jql: 'x' },
      registry,
      sessions: makeSessions({ jira }),
      namespacing: NS,
    });

    expect(result).toEqual({ kind: 'server_unavailable', server: 'jira', status: errored });
    expect(jira.calls).toEqual([]);
  });

  it('returns server_unavailable with synthetic stopped status when the session is removed mid-call', async () => {
    const jiraEntry = entry('jira', 'search');
    const registry = makeRegistry([jiraEntry]);

    const result = await routeToolCall({
      exposedName: 'jira__search',
      args: undefined,
      registry,
      sessions: makeSessions({}),
      namespacing: NS,
    });

    expect(result).toEqual({
      kind: 'server_unavailable',
      server: 'jira',
      status: { kind: 'stopped' },
    });
  });

  it.each<[string, unknown]>([
    ['array', [1, 2, 3]],
    ['string', 'hello'],
    ['null', null],
    ['number', 42],
  ])('returns invalid_args when args is a %s', async (_label, badArgs) => {
    const jiraEntry = entry('jira', 'search');
    const registry = makeRegistry([jiraEntry]);
    const jira = makeSession({});

    const result = await routeToolCall({
      exposedName: 'jira__search',
      args: badArgs,
      registry,
      sessions: makeSessions({ jira }),
      namespacing: NS,
    });

    expect(result.kind).toBe('invalid_args');
    if (result.kind === 'invalid_args') {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.path).toEqual([]);
      expect(result.issues[0]?.message).toBe('arguments must be an object');
    }
    expect(jira.calls).toEqual([]);
  });

  it('returns upstream_error when the session throws an Error', async () => {
    const jiraEntry = entry('jira', 'search');
    const registry = makeRegistry([jiraEntry]);
    const boom = new Error('upstream blew up');
    const jira = makeSession({ throwValue: boom });

    const result = await routeToolCall({
      exposedName: 'jira__search',
      args: { jql: 'x' },
      registry,
      sessions: makeSessions({ jira }),
      namespacing: NS,
    });

    expect(result).toEqual({ kind: 'upstream_error', server: 'jira', error: boom });
  });

  it('coerces non-Error throws into Error instances in upstream_error', async () => {
    const jiraEntry = entry('jira', 'search');
    const registry = makeRegistry([jiraEntry]);
    const jira = makeSession({ throwValue: 'string boom' });

    const result = await routeToolCall({
      exposedName: 'jira__search',
      args: undefined,
      registry,
      sessions: makeSessions({ jira }),
      namespacing: NS,
    });

    expect(result.kind).toBe('upstream_error');
    if (result.kind === 'upstream_error') {
      expect(result.server).toBe('jira');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('string boom');
    }
  });

  it('never throws — every branch resolves to a RouteResult', async () => {
    const jiraEntry = entry('jira', 'search');
    const registry = makeRegistry([jiraEntry]);

    await expect(
      routeToolCall({
        exposedName: 'jira__search',
        args: undefined,
        registry,
        sessions: makeSessions({ jira: makeSession({}) }),
        namespacing: NS,
      }),
    ).resolves.toMatchObject({ kind: 'ok' });

    await expect(
      routeToolCall({
        exposedName: 'no-separator',
        args: undefined,
        registry,
        sessions: makeSessions({}),
        namespacing: NS,
      }),
    ).resolves.toMatchObject({ kind: 'unknown_tool' });

    await expect(
      routeToolCall({
        exposedName: 'jira__search',
        args: 'oops',
        registry,
        sessions: makeSessions({ jira: makeSession({}) }),
        namespacing: NS,
      }),
    ).resolves.toMatchObject({ kind: 'invalid_args' });

    await expect(
      routeToolCall({
        exposedName: 'jira__search',
        args: undefined,
        registry,
        sessions: makeSessions({ jira: makeSession({ status: { kind: 'stopped' } }) }),
        namespacing: NS,
      }),
    ).resolves.toMatchObject({ kind: 'server_unavailable' });

    await expect(
      routeToolCall({
        exposedName: 'jira__search',
        args: undefined,
        registry,
        sessions: makeSessions({ jira: makeSession({ throwValue: new Error('x') }) }),
        namespacing: NS,
      }),
    ).resolves.toMatchObject({ kind: 'upstream_error' });
  });
});
