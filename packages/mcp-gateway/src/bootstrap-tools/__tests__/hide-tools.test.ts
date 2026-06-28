import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  createSessionVisibility,
  type SessionVisibility,
  type SessionVisibilityChangeReason,
} from '@toolbx/core';
import { describe, expect, it, vi } from 'vitest';

import { BOOTSTRAP_TOOL_NAMES, HIDE_TOOLS_NAME } from '../names.js';
import { createHideToolsBootstrap } from '../hide-tools.js';

interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

interface HideResultLine {
  readonly kind: 'hide-result';
  readonly hidden: readonly string[];
  readonly notVisible: readonly string[];
  readonly visibleCount: number;
}

function freshVisibility(prerevealed: readonly string[] = []): SessionVisibility {
  const v = createSessionVisibility({
    mode: 'session',
    bootstrapToolNames: BOOTSTRAP_TOOL_NAMES,
  });
  if (prerevealed.length > 0) {
    v.reveal(prerevealed);
  }
  return v;
}

function parseResultLine(result: CallToolResult): HideResultLine {
  const blocks = result.content as TextBlock[];
  expect(blocks).toHaveLength(1);
  const first = blocks[0];
  expect(first).toBeDefined();
  return JSON.parse(first!.text) as HideResultLine;
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const blocks = result.content as TextBlock[];
  expect(blocks).toHaveLength(1);
  return blocks[0]!.text;
}

describe('toolbx__hide_tools (M4-04)', () => {
  it('exposes the canonical descriptor', () => {
    const hide = createHideToolsBootstrap({ visibility: freshVisibility() });
    expect(hide.descriptor.name).toBe(HIDE_TOOLS_NAME);
    expect(hide.descriptor.inputSchema).toBeDefined();
  });

  it('hides a currently-revealed tool and reports it', async () => {
    const visibility = freshVisibility(['jira__search_issues', 'github__create_issue']);
    const hide = createHideToolsBootstrap({ visibility });

    const result = await hide.invoke({ tools: ['jira__search_issues'] });

    expect(result.isError).toBeUndefined();
    const line = parseResultLine(result);
    expect(line).toEqual({
      kind: 'hide-result',
      hidden: ['jira__search_issues'],
      notVisible: [],
      visibleCount: 1,
    });
    expect(visibility.isVisible('jira__search_issues')).toBe(false);
    expect(visibility.list()).toEqual(['github__create_issue']);
  });

  it('hides multiple tools and sorts the response by byte order', async () => {
    const visibility = freshVisibility([
      'jira__search_issues',
      'jira__create_issue',
      'github__create_issue',
    ]);
    const hide = createHideToolsBootstrap({ visibility });

    const result = await hide.invoke({
      tools: ['jira__search_issues', 'github__create_issue', 'jira__create_issue'],
    });

    const line = parseResultLine(result);
    expect(line.hidden).toEqual([
      'github__create_issue',
      'jira__create_issue',
      'jira__search_issues',
    ]);
    expect(line.notVisible).toEqual([]);
    expect(line.visibleCount).toBe(0);
  });

  it('reports already-hidden / unknown names as notVisible without erroring', async () => {
    const visibility = freshVisibility(['jira__search_issues']);
    const hide = createHideToolsBootstrap({ visibility });

    const result = await hide.invoke({
      tools: ['jira__search_issues', 'never__revealed', 'jira__create_issue'],
    });

    expect(result.isError).toBeUndefined();
    const line = parseResultLine(result);
    expect(line.hidden).toEqual(['jira__search_issues']);
    expect(line.notVisible).toEqual(['jira__create_issue', 'never__revealed']);
    expect(line.visibleCount).toBe(0);
  });

  it('rejects bootstrap names with a dedicated error and does not mutate state', async () => {
    const visibility = freshVisibility(['jira__search_issues']);
    const hide = createHideToolsBootstrap({ visibility });

    const result = await hide.invoke({
      tools: ['toolbx__search_tools', 'jira__search_issues'],
    });

    const text = errorText(result);
    expect(text).toContain('cannot hide bootstrap tools:');
    expect(text).toContain('toolbx__search_tools');
    expect(visibility.list()).toEqual(['jira__search_issues']);
    expect(visibility.isVisible('toolbx__search_tools')).toBe(true);
  });

  it('rejects every planned bootstrap name', async () => {
    const visibility = freshVisibility();
    const hide = createHideToolsBootstrap({ visibility });

    for (const name of BOOTSTRAP_TOOL_NAMES) {
      const result = await hide.invoke({ tools: [name] });
      const text = errorText(result);
      expect(text).toContain('cannot hide bootstrap tools:');
      expect(text).toContain(name);
    }
  });

  it('deduplicates input names', async () => {
    const visibility = freshVisibility(['jira__search_issues']);
    const hide = createHideToolsBootstrap({ visibility });

    const result = await hide.invoke({
      tools: ['jira__search_issues', 'jira__search_issues'],
    });

    const line = parseResultLine(result);
    expect(line.hidden).toEqual(['jira__search_issues']);
    expect(line.notVisible).toEqual([]);
  });

  it('emits exactly one change event on a successful hide', async () => {
    const visibility = freshVisibility(['jira__search_issues', 'github__create_issue']);
    const hide = createHideToolsBootstrap({ visibility });

    const events: SessionVisibilityChangeReason[] = [];
    visibility.on('change', (e) => events.push(e));

    await hide.invoke({ tools: ['jira__search_issues', 'github__create_issue'] });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'hide',
      removed: ['github__create_issue', 'jira__search_issues'],
    });
  });

  it('does not emit a change event when the request is rejected', async () => {
    const visibility = freshVisibility(['jira__search_issues']);
    const hide = createHideToolsBootstrap({ visibility });

    const listener = vi.fn();
    visibility.on('change', listener);

    await hide.invoke({ tools: ['toolbx__search_tools'] });

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not emit a change event when no name was actually hidden', async () => {
    const visibility = freshVisibility();
    const hide = createHideToolsBootstrap({ visibility });

    const listener = vi.fn();
    visibility.on('change', listener);

    const result = await hide.invoke({ tools: ['never__revealed'] });

    expect(result.isError).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects malformed args (missing tools field)', async () => {
    const hide = createHideToolsBootstrap({ visibility: freshVisibility() });

    const result = await hide.invoke({});

    const text = errorText(result);
    expect(text).toContain(`invalid arguments to ${HIDE_TOOLS_NAME}`);
    expect(text).toContain('tools');
  });

  it('rejects an empty tools array', async () => {
    const hide = createHideToolsBootstrap({ visibility: freshVisibility() });

    const result = await hide.invoke({ tools: [] });

    const text = errorText(result);
    expect(text).toContain(`invalid arguments to ${HIDE_TOOLS_NAME}`);
  });

  it('rejects extra top-level properties', async () => {
    const hide = createHideToolsBootstrap({ visibility: freshVisibility() });

    const result = await hide.invoke({ tools: ['jira__search_issues'], extra: 1 });

    const text = errorText(result);
    expect(text).toContain(`invalid arguments to ${HIDE_TOOLS_NAME}`);
  });
});
