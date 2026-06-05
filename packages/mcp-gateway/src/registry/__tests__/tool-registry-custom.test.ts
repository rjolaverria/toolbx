import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { NamespaceOptions, ServerStatus } from '@toolbox/core';
import { describe, expect, it, vi } from 'vitest';

import { createToolRegistry, type CustomToolInput } from '../tool-registry.js';

const NS: NamespaceOptions = { separator: '__', format: 'server__tool' };
const CONNECTED: ServerStatus = { kind: 'connected', since: new Date('2026-01-01T00:00:00Z') };

function tool(name: string, description?: string): Tool {
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  };
}

function custom(namespace: string, name: string, description?: string): CustomToolInput {
  const exposedName = `${namespace}__${name}`;
  return { exposedName, namespace, name, tool: tool(exposedName, description) };
}

describe('createToolRegistry — custom tools', () => {
  it('lists custom tools alongside upstream tools, marked source: custom', () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search')],
    });
    registry.setCustomTools([custom('personal', 'echo', 'Echo a message')]);

    const list = registry.list();
    expect(list.map((t) => t.exposedName)).toEqual(['jira__search', 'personal__echo']);
    const echo = list.find((t) => t.exposedName === 'personal__echo');
    expect(echo).toMatchObject({
      exposedName: 'personal__echo',
      serverName: 'personal',
      upstreamName: 'echo',
      source: 'custom',
    });
    expect(echo?.tool.description).toBe('Echo a message');
  });

  it('marks upstream tools source: upstream', () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search')],
    });
    expect(registry.find('jira__search')?.source).toBe('upstream');
  });

  it('strips ToolBox-reserved _meta keys from upstream tools (no marker spoofing)', () => {
    const registry = createToolRegistry({ namespacing: NS });
    const spoofed: Tool = {
      ...tool('search'),
      _meta: { 'toolbox/custom': true, 'toolbox/bootstrap': true, keep: 'me' },
    };
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [spoofed],
    });
    const entry = registry.find('jira__search');
    expect(entry?.source).toBe('upstream');
    expect(entry?.tool._meta).toEqual({ keep: 'me' });
  });

  it('finds a custom tool by exposed name', () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setCustomTools([custom('personal', 'echo')]);
    expect(registry.find('personal__echo')).toMatchObject({ source: 'custom' });
  });

  it('replaces the custom set wholesale on each call', () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setCustomTools([custom('personal', 'echo'), custom('personal', 'greet')]);
    registry.setCustomTools([custom('personal', 'greet')]);

    expect(registry.find('personal__echo')).toBeUndefined();
    expect(registry.find('personal__greet')).toBeDefined();
    expect(registry.list().map((t) => t.exposedName)).toEqual(['personal__greet']);
  });

  it('notifies subscribers when the custom set changes', () => {
    const registry = createToolRegistry({ namespacing: NS });
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.setCustomTools([custom('personal', 'echo')]);
    expect(listener).toHaveBeenCalledTimes(1);

    // Same set again — no change, no notification.
    registry.setCustomTools([custom('personal', 'echo')]);
    expect(listener).toHaveBeenCalledTimes(1);

    registry.setCustomTools([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
