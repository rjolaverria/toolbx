import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { NamespaceOptions, ServerStatus } from '@toolbox/core';
import { describe, expect, it, vi } from 'vitest';

import { createToolRegistry } from '../tool-registry.js';

const NS: NamespaceOptions = { separator: '__', format: 'server__tool' };

const CONNECTED: ServerStatus = { kind: 'connected', since: new Date('2026-01-01T00:00:00Z') };

function tool(name: string, description?: string): Tool {
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  };
}

describe('createToolRegistry', () => {
  it('returns the union of two healthy servers, all namespaced and sorted', () => {
    const registry = createToolRegistry({ namespacing: NS });

    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues', 'Search'), tool('create_issue', 'Create')],
    });
    registry.setServerEntry({
      serverName: 'github',
      status: CONNECTED,
      enabled: true,
      tools: [tool('create_pull_request')],
    });

    const list = registry.list();
    expect(list.map((t) => t.exposedName)).toEqual([
      'github__create_pull_request',
      'jira__create_issue',
      'jira__search_issues',
    ]);
    expect(list[0]?.tool.name).toBe('github__create_pull_request');
    expect(list[2]?.tool.description).toBe('Search');
    expect(list[2]?.upstreamName).toBe('search_issues');
    expect(list[2]?.serverName).toBe('jira');
  });

  it('drops a servers tools when its entry is updated to enabled=false', () => {
    const registry = createToolRegistry({ namespacing: NS });

    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    registry.setServerEntry({
      serverName: 'github',
      status: CONNECTED,
      enabled: true,
      tools: [tool('create_pull_request')],
    });

    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: false,
      tools: [tool('search_issues')],
    });

    expect(registry.list().map((t) => t.exposedName)).toEqual(['github__create_pull_request']);
  });

  it.each<ServerStatus>([
    { kind: 'disabled' },
    { kind: 'auth_required', reason: 'oauth flow pending' },
    { kind: 'auth_expired', reason: 'token expired' },
    { kind: 'error', error: new Error('boom'), nextRetryAt: null },
    { kind: 'starting', attempt: 1 },
    { kind: 'stopped' },
  ])('does not contribute tools when status.kind is $kind', (status) => {
    const registry = createToolRegistry({ namespacing: NS });

    registry.setServerEntry({
      serverName: 'jira',
      status,
      enabled: true,
      tools: [tool('search_issues')],
    });

    expect(registry.list()).toEqual([]);
  });

  it('removes a server entirely on removeServer', () => {
    const registry = createToolRegistry({ namespacing: NS });

    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    registry.removeServer('jira');
    expect(registry.list()).toEqual([]);
  });

  it('produces deterministic locale-aware ordering across server and tool boundaries', () => {
    const registry = createToolRegistry({ namespacing: NS });

    // Insert in a deliberately scrambled order; expect alphabetic by
    // (serverName, upstreamName).
    registry.setServerEntry({
      serverName: 'zeta',
      status: CONNECTED,
      enabled: true,
      tools: [tool('zoo'), tool('alpha')],
    });
    registry.setServerEntry({
      serverName: 'alpha',
      status: CONNECTED,
      enabled: true,
      tools: [tool('beta'), tool('alpha')],
    });

    expect(registry.list().map((t) => t.exposedName)).toEqual([
      'alpha__alpha',
      'alpha__beta',
      'zeta__alpha',
      'zeta__zoo',
    ]);
  });

  it('preserves upstream tool names containing the separator', () => {
    const registry = createToolRegistry({ namespacing: NS });

    registry.setServerEntry({
      serverName: 'srv',
      status: CONNECTED,
      enabled: true,
      tools: [tool('weird__tool')],
    });

    const [entry] = registry.list();
    expect(entry?.exposedName).toBe('srv__weird__tool');
    expect(entry?.upstreamName).toBe('weird__tool');
  });

  it('notifies subscribers when the visible tool set changes', () => {
    const registry = createToolRegistry({ namespacing: NS });
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    expect(listener).toHaveBeenCalledTimes(1);

    // No-op write (same exposed names) does not notify.
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    expect(listener).toHaveBeenCalledTimes(1);

    // Removing a non-visible server is a no-op.
    registry.removeServer('does-not-exist');
    expect(listener).toHaveBeenCalledTimes(1);

    // Disabling an existing visible server notifies.
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: false,
      tools: [tool('search_issues')],
    });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues')],
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
