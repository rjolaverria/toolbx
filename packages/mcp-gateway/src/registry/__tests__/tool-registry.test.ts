import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { NamespaceOptions, ServerStatus } from '@rjolaverria/toolbox-core';
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

  it('keeps contributing tools while status.kind is auth_expired so a call can drive recovery', () => {
    // An auth_expired server stays visible: the agent can still call its tools
    // (the call returns a structured re-auth message), and routeToolCall needs
    // the entry to reach the session and drive the next-call recovery (F1-21).
    const registry = createToolRegistry({ namespacing: NS });

    registry.setServerEntry({
      serverName: 'jira',
      status: { kind: 'auth_expired', reason: 'token expired' },
      enabled: true,
      tools: [tool('search_issues')],
    });

    expect(registry.list().map((t) => t.exposedName)).toEqual(['jira__search_issues']);
    expect(registry.find('jira__search_issues')).toBeDefined();
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

  it('produces deterministic byte-order sorting across server and tool boundaries', () => {
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

  it('notifies subscribers when only tool metadata changes (e.g. description)', () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues', 'old description')],
    });

    const listener = vi.fn();
    registry.subscribe(listener);

    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('search_issues', 'new description')],
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when upstream returns the same tools in a different order', () => {
    const registry = createToolRegistry({ namespacing: NS });
    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('a'), tool('b')],
    });

    const listener = vi.fn();
    registry.subscribe(listener);

    registry.setServerEntry({
      serverName: 'jira',
      status: CONNECTED,
      enabled: true,
      tools: [tool('b'), tool('a')],
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not notify on the first insert of a non-visible server', () => {
    const registry = createToolRegistry({ namespacing: NS });
    const listener = vi.fn();
    registry.subscribe(listener);

    // First inserts in non-visible states (disabled, starting, auth_required,
    // …). Visible tool set is empty before AND after, so no notification.
    registry.setServerEntry({
      serverName: 'jira',
      status: { kind: 'starting', attempt: 1 },
      enabled: true,
      tools: [tool('search_issues')],
    });
    registry.setServerEntry({
      serverName: 'github',
      status: { kind: 'auth_required', reason: 'oauth pending' },
      enabled: true,
      tools: [tool('create_pull_request')],
    });
    registry.setServerEntry({
      serverName: 'gitlab',
      status: { kind: 'connected', since: new Date() },
      enabled: false,
      tools: [tool('search')],
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not notify when a non-visible server transitions between non-visible statuses', () => {
    const registry = createToolRegistry({ namespacing: NS });

    // Start in `starting` (non-visible).
    registry.setServerEntry({
      serverName: 'jira',
      status: { kind: 'starting', attempt: 1 },
      enabled: true,
      tools: [],
    });

    const listener = vi.fn();
    registry.subscribe(listener);

    // starting → error (still non-visible). Visible tool set is unchanged,
    // so subscribers should not be notified during reconnect/auth churn.
    registry.setServerEntry({
      serverName: 'jira',
      status: { kind: 'error', error: new Error('boom'), nextRetryAt: null },
      enabled: true,
      tools: [],
    });

    expect(listener).not.toHaveBeenCalled();
  });

  describe('find', () => {
    it('returns a visible tool by its exposed name', () => {
      const registry = createToolRegistry({ namespacing: NS });
      registry.setServerEntry({
        serverName: 'jira',
        status: CONNECTED,
        enabled: true,
        tools: [tool('search_issues', 'Search')],
      });

      const found = registry.find('jira__search_issues');
      expect(found?.serverName).toBe('jira');
      expect(found?.upstreamName).toBe('search_issues');
      expect(found?.tool.name).toBe('jira__search_issues');
      expect(found?.tool.description).toBe('Search');
    });

    it('returns undefined for an unknown exposed name', () => {
      const registry = createToolRegistry({ namespacing: NS });
      registry.setServerEntry({
        serverName: 'jira',
        status: CONNECTED,
        enabled: true,
        tools: [tool('search_issues')],
      });

      expect(registry.find('jira__nope')).toBeUndefined();
      expect(registry.find('search_issues')).toBeUndefined();
    });

    it('does not surface tools from a disabled server', () => {
      const registry = createToolRegistry({ namespacing: NS });
      registry.setServerEntry({
        serverName: 'jira',
        status: CONNECTED,
        enabled: false,
        tools: [tool('search_issues')],
      });

      expect(registry.find('jira__search_issues')).toBeUndefined();
    });

    it('does not surface tools from a server stuck in auth_required', () => {
      const registry = createToolRegistry({ namespacing: NS });
      registry.setServerEntry({
        serverName: 'jira',
        status: { kind: 'auth_required', reason: 'oauth pending' },
        enabled: true,
        tools: [tool('search_issues')],
      });

      expect(registry.find('jira__search_issues')).toBeUndefined();
    });

    it('reflects mutations: tools come and go as setServerEntry / removeServer fire', () => {
      const registry = createToolRegistry({ namespacing: NS });
      registry.setServerEntry({
        serverName: 'jira',
        status: CONNECTED,
        enabled: true,
        tools: [tool('search_issues'), tool('create_issue')],
      });
      expect(registry.find('jira__search_issues')).toBeDefined();
      expect(registry.find('jira__create_issue')).toBeDefined();

      registry.setServerEntry({
        serverName: 'jira',
        status: CONNECTED,
        enabled: true,
        tools: [tool('search_issues')],
      });
      expect(registry.find('jira__search_issues')).toBeDefined();
      expect(registry.find('jira__create_issue')).toBeUndefined();

      registry.removeServer('jira');
      expect(registry.find('jira__search_issues')).toBeUndefined();
    });
  });
});
