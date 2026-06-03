import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import type { NamespaceOptions } from '../../namespace/index.js';
import type { RegisteredToolView, RegistryView } from '../registry-view.js';
import { routeToolCall, type CustomToolExecutor } from '../route.js';
import type { SessionLookup } from '../session-view.js';

const NS: NamespaceOptions = { separator: '__', format: 'server__tool' };

function tool(name: string): Tool {
  return { name, inputSchema: { type: 'object' as const, properties: {}, required: [] } };
}

function customEntry(namespace: string, name: string): RegisteredToolView {
  return {
    exposedName: `${namespace}__${name}`,
    serverName: namespace,
    upstreamName: name,
    tool: tool(`${namespace}__${name}`),
    source: 'custom',
  };
}

function makeRegistry(entries: readonly RegisteredToolView[]): RegistryView {
  const map = new Map(entries.map((e) => [e.exposedName, e]));
  return { find: (name) => map.get(name) };
}

const NO_SESSIONS: SessionLookup = { get: () => undefined };

describe('routeToolCall — custom tools', () => {
  it('dispatches a custom-source tool to the customExecutor, never the session lookup', async () => {
    const view = customEntry('personal', 'echo');
    const result: CallToolResult = { content: [{ type: 'text', text: 'hi' }] };
    const run = vi.fn().mockResolvedValue({ kind: 'ok', result });
    const executor: CustomToolExecutor = { run };
    const sessionsGet = vi.fn(() => undefined);

    const outcome = await routeToolCall({
      exposedName: 'personal__echo',
      args: { who: 'world' },
      registry: makeRegistry([view]),
      sessions: { get: sessionsGet },
      namespacing: NS,
      customExecutor: executor,
    });

    expect(outcome).toEqual({ kind: 'ok', result });
    expect(run).toHaveBeenCalledWith(view, { who: 'world' }, undefined);
    expect(sessionsGet).not.toHaveBeenCalled();
  });

  it('rejects non-object args for a custom tool before calling the executor', async () => {
    const view = customEntry('personal', 'echo');
    const run = vi.fn();
    const executor: CustomToolExecutor = { run };

    const outcome = await routeToolCall({
      exposedName: 'personal__echo',
      args: 'not-an-object',
      registry: makeRegistry([view]),
      sessions: NO_SESSIONS,
      namespacing: NS,
      customExecutor: executor,
    });

    expect(outcome.kind).toBe('invalid_args');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns unknown_tool for a custom entry when no executor is wired', async () => {
    const view = customEntry('personal', 'echo');

    const outcome = await routeToolCall({
      exposedName: 'personal__echo',
      args: {},
      registry: makeRegistry([view]),
      sessions: NO_SESSIONS,
      namespacing: NS,
    });

    expect(outcome).toEqual({ kind: 'unknown_tool' });
  });

  it('forwards the caller AbortSignal to the executor', async () => {
    const view = customEntry('personal', 'echo');
    const run = vi.fn().mockResolvedValue({ kind: 'ok', result: { content: [] } });
    const executor: CustomToolExecutor = { run };
    const controller = new AbortController();

    await routeToolCall({
      exposedName: 'personal__echo',
      args: undefined,
      registry: makeRegistry([view]),
      sessions: NO_SESSIONS,
      namespacing: NS,
      customExecutor: executor,
      signal: controller.signal,
    });

    expect(run).toHaveBeenCalledWith(view, undefined, controller.signal);
  });
});
