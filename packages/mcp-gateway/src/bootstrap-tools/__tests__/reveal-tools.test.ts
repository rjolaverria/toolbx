import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  createSessionVisibility,
  type NamespaceOptions,
  type ServerStatus,
  type SessionVisibility,
  type SessionVisibilityChangeReason,
} from '@toolbox/core';
import { describe, expect, it, vi } from 'vitest';

import { createToolRegistry, type ToolRegistry } from '../../registry/index.js';
import { BOOTSTRAP_TOOL_NAMES, REVEAL_TOOLS_NAME } from '../names.js';
import { createRevealToolsBootstrap } from '../reveal-tools.js';

const NS: NamespaceOptions = { separator: '__', format: 'server__tool' };
const CONNECTED: ServerStatus = { kind: 'connected', since: new Date('2026-01-01T00:00:00Z') };

interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

interface RevealResultLine {
  readonly kind: 'reveal-result';
  readonly revealed: readonly string[];
  readonly alreadyVisible: readonly string[];
  readonly visibleCount: number;
}

function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  };
}

function populated(): ToolRegistry {
  const registry = createToolRegistry({ namespacing: NS });
  registry.setServerEntry({
    serverName: 'jira',
    status: CONNECTED,
    enabled: true,
    tools: [tool('search_issues'), tool('create_issue')],
  });
  registry.setServerEntry({
    serverName: 'github',
    status: CONNECTED,
    enabled: true,
    tools: [tool('create_issue')],
  });
  return registry;
}

function freshVisibility(): SessionVisibility {
  return createSessionVisibility({
    mode: 'session',
    bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
  });
}

function parseResultLine(result: CallToolResult): RevealResultLine {
  const blocks = result.content as TextBlock[];
  expect(blocks).toHaveLength(1);
  const first = blocks[0];
  expect(first).toBeDefined();
  return JSON.parse(first!.text) as RevealResultLine;
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const blocks = result.content as TextBlock[];
  expect(blocks).toHaveLength(1);
  return blocks[0]!.text;
}

describe('toolbox__reveal_tools (M4-04)', () => {
  it('exposes the canonical descriptor', () => {
    const reveal = createRevealToolsBootstrap({
      visibility: freshVisibility(),
      toolRegistry: populated(),
    });
    expect(reveal.descriptor.name).toBe(REVEAL_TOOLS_NAME);
    expect(reveal.descriptor.inputSchema).toBeDefined();
  });

  it('reveals a known upstream tool and reports it as newly visible', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const result = await reveal.invoke({ tools: ['jira__search_issues'] });

    expect(result.isError).toBeUndefined();
    const line = parseResultLine(result);
    expect(line).toEqual({
      kind: 'reveal-result',
      revealed: ['jira__search_issues'],
      alreadyVisible: [],
      visibleCount: 1,
    });
    expect(visibility.isVisible('jira__search_issues')).toBe(true);
    expect(visibility.list()).toEqual(['jira__search_issues']);
  });

  it('reveals multiple tools sorted by byte order in the response', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const result = await reveal.invoke({
      tools: ['jira__search_issues', 'github__create_issue', 'jira__create_issue'],
    });

    const line = parseResultLine(result);
    expect(line.revealed).toEqual([
      'github__create_issue',
      'jira__create_issue',
      'jira__search_issues',
    ]);
    expect(line.alreadyVisible).toEqual([]);
    expect(line.visibleCount).toBe(3);
  });

  it('treats already-visible tools as alreadyVisible without firing change events', async () => {
    const visibility = freshVisibility();
    visibility.reveal(['jira__search_issues']);
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const listener = vi.fn();
    visibility.on('change', listener);

    const result = await reveal.invoke({ tools: ['jira__search_issues'] });

    const line = parseResultLine(result);
    expect(line.revealed).toEqual([]);
    expect(line.alreadyVisible).toEqual(['jira__search_issues']);
    expect(line.visibleCount).toBe(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects unknown names and lists every bad entry without mutating state', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const result = await reveal.invoke({
      tools: ['jira__search_issues', 'nope__missing', 'also__missing'],
    });

    const text = errorText(result);
    expect(text).toContain('unknown tools:');
    expect(text).toContain('nope__missing');
    expect(text).toContain('also__missing');
    expect(text).not.toContain('jira__search_issues');
    expect(visibility.list()).toEqual([]);
  });

  it('rejects bootstrap names with a dedicated error and does not mutate state', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const result = await reveal.invoke({
      tools: ['toolbox__search_tools', 'jira__search_issues'],
    });

    const text = errorText(result);
    expect(text).toContain('cannot reveal bootstrap tools:');
    expect(text).toContain('toolbox__search_tools');
    expect(visibility.list()).toEqual([]);
  });

  it('prefers the bootstrap-name error over the unknown-name error when both apply', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const result = await reveal.invoke({
      tools: ['toolbox__search_tools', 'nope__missing', 'jira__search_issues'],
    });

    const text = errorText(result);
    expect(text).toContain('cannot reveal bootstrap tools:');
    expect(text).not.toContain('unknown tools:');
    expect(visibility.list()).toEqual([]);
  });

  it('deduplicates input names', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const result = await reveal.invoke({
      tools: ['jira__search_issues', 'jira__search_issues'],
    });

    const line = parseResultLine(result);
    expect(line.revealed).toEqual(['jira__search_issues']);
    expect(line.alreadyVisible).toEqual([]);
    expect(line.visibleCount).toBe(1);
  });

  it('emits exactly one change event on a successful reveal', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const events: SessionVisibilityChangeReason[] = [];
    visibility.on('change', (e) => events.push(e));

    await reveal.invoke({ tools: ['jira__search_issues', 'github__create_issue'] });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'reveal',
      added: ['github__create_issue', 'jira__search_issues'],
    });
  });

  it('does not emit a change event when the request is rejected', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const listener = vi.fn();
    visibility.on('change', listener);

    await reveal.invoke({ tools: ['nope__missing'] });
    await reveal.invoke({ tools: ['toolbox__search_tools'] });

    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects malformed args (missing tools field)', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const result = await reveal.invoke({});

    const text = errorText(result);
    expect(text).toContain(`invalid arguments to ${REVEAL_TOOLS_NAME}`);
    expect(text).toContain('tools');
  });

  it('rejects an empty tools array', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const result = await reveal.invoke({ tools: [] });

    const text = errorText(result);
    expect(text).toContain(`invalid arguments to ${REVEAL_TOOLS_NAME}`);
  });

  it('rejects non-string elements', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const result = await reveal.invoke({ tools: [42] });

    const text = errorText(result);
    expect(text).toContain(`invalid arguments to ${REVEAL_TOOLS_NAME}`);
  });

  it('rejects extra top-level properties', async () => {
    const visibility = freshVisibility();
    const reveal = createRevealToolsBootstrap({ visibility, toolRegistry: populated() });

    const result = await reveal.invoke({ tools: ['jira__search_issues'], extra: true });

    const text = errorText(result);
    expect(text).toContain(`invalid arguments to ${REVEAL_TOOLS_NAME}`);
  });
});
