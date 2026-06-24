import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { createSessionVisibility, type SessionVisibility } from '@rjolaverria/toolbox-core';
import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_TOOL_NAMES, LIST_REVEALED_TOOLS_NAME } from '../names.js';
import { createListRevealedToolsBootstrap } from '../list-revealed-tools.js';

interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

interface RevealedToolsLine {
  readonly kind: 'revealed-tools';
  readonly bootstrapTools: readonly string[];
  readonly revealed: readonly string[];
  readonly total: number;
}

const SORTED_BOOTSTRAP = [...BOOTSTRAP_TOOL_NAMES].sort();

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

function parseLine(result: CallToolResult): RevealedToolsLine {
  const blocks = result.content as TextBlock[];
  expect(blocks).toHaveLength(1);
  const first = blocks[0];
  expect(first).toBeDefined();
  return JSON.parse(first!.text) as RevealedToolsLine;
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const blocks = result.content as TextBlock[];
  expect(blocks).toHaveLength(1);
  return blocks[0]!.text;
}

describe('toolbox__list_revealed_tools (M4-05)', () => {
  it('exposes the canonical descriptor', () => {
    const tool = createListRevealedToolsBootstrap({ visibility: freshVisibility() });
    expect(tool.descriptor.name).toBe(LIST_REVEALED_TOOLS_NAME);
    expect(tool.descriptor.inputSchema).toMatchObject({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it('always returns the bootstrap tools, even when nothing is revealed', async () => {
    const tool = createListRevealedToolsBootstrap({ visibility: freshVisibility() });

    const result = await tool.invoke({});

    expect(result.isError).toBeUndefined();
    const line = parseLine(result);
    expect(line.kind).toBe('revealed-tools');
    expect(line.bootstrapTools).toEqual(SORTED_BOOTSTRAP);
    expect(line.revealed).toEqual([]);
    expect(line.total).toBe(SORTED_BOOTSTRAP.length);
  });

  it('returns revealed names alongside the bootstrap tools', async () => {
    const visibility = freshVisibility(['jira__search_issues', 'github__create_issue']);
    const tool = createListRevealedToolsBootstrap({ visibility });

    const line = parseLine(await tool.invoke({}));
    expect(line.bootstrapTools).toEqual(SORTED_BOOTSTRAP);
    expect(line.revealed).toEqual(['github__create_issue', 'jira__search_issues']);
    expect(line.total).toBe(SORTED_BOOTSTRAP.length + 2);
  });

  it('sorts revealed names by byte order', async () => {
    const visibility = freshVisibility([
      'zebra__roar',
      'alpha__beta',
      'mango__taste',
      'alpha__alpha',
    ]);
    const tool = createListRevealedToolsBootstrap({ visibility });

    const line = parseLine(await tool.invoke({}));
    expect(line.revealed).toEqual(['alpha__alpha', 'alpha__beta', 'mango__taste', 'zebra__roar']);
  });

  it('reflects subsequent reveal/hide mutations on each call', async () => {
    const visibility = freshVisibility();
    const tool = createListRevealedToolsBootstrap({ visibility });

    let line = parseLine(await tool.invoke({}));
    expect(line.revealed).toEqual([]);

    visibility.reveal(['jira__search_issues']);
    line = parseLine(await tool.invoke({}));
    expect(line.revealed).toEqual(['jira__search_issues']);

    visibility.reveal(['github__create_issue']);
    line = parseLine(await tool.invoke({}));
    expect(line.revealed).toEqual(['github__create_issue', 'jira__search_issues']);

    visibility.hide(['jira__search_issues']);
    line = parseLine(await tool.invoke({}));
    expect(line.revealed).toEqual(['github__create_issue']);
  });

  it('does not mutate session visibility on invocation', async () => {
    const visibility = freshVisibility(['jira__search_issues']);
    const tool = createListRevealedToolsBootstrap({ visibility });

    const before = visibility.list();
    await tool.invoke({});
    await tool.invoke({});
    const after = visibility.list();
    expect(after).toEqual(before);
  });

  it('treats omitted args as the default (empty object)', async () => {
    const tool = createListRevealedToolsBootstrap({ visibility: freshVisibility() });
    const line = parseLine(await tool.invoke(undefined));
    expect(line.bootstrapTools).toEqual(SORTED_BOOTSTRAP);
  });

  it('rejects extra top-level properties', async () => {
    const tool = createListRevealedToolsBootstrap({ visibility: freshVisibility() });
    const text = errorText(await tool.invoke({ extra: 1 }));
    expect(text).toContain(`invalid arguments to ${LIST_REVEALED_TOOLS_NAME}`);
  });

  it('does not include bootstrap names in the revealed list even when they share visibility', async () => {
    // SessionVisibility.list() filters bootstrap names out; this test pins the
    // contract so a future change to that filter doesn't silently leak them
    // into the revealed array.
    const visibility = freshVisibility(['jira__search_issues']);
    const tool = createListRevealedToolsBootstrap({ visibility });

    const line = parseLine(await tool.invoke({}));
    for (const bootstrapName of BOOTSTRAP_TOOL_NAMES) {
      expect(line.revealed).not.toContain(bootstrapName);
    }
    expect(line.bootstrapTools).toEqual(SORTED_BOOTSTRAP);
  });

  it('reports no bootstrap tools when the session was created without bootstrapToolNames', async () => {
    // `createSessionVisibility` supports omitting `bootstrapToolNames` (the
    // bootstrap-tools feature is opt-in via config). The tool must reflect
    // that and not invent bootstrap visibility from the canonical constant.
    const visibility = createSessionVisibility({ mode: 'session' });
    visibility.reveal(['jira__search_issues']);
    const tool = createListRevealedToolsBootstrap({ visibility });

    const line = parseLine(await tool.invoke({}));
    expect(line.bootstrapTools).toEqual([]);
    expect(line.revealed).toEqual(['jira__search_issues']);
    expect(line.total).toBe(1);
  });

  it('reports only the bootstrap names the session actually treats as visible', async () => {
    // Wire the session with a non-canonical bootstrap subset (e.g. a future
    // config that disables some bootstrap tools) and confirm the tool mirrors
    // exactly that subset rather than the full canonical list.
    const subset = [BOOTSTRAP_TOOL_NAMES[0]!, BOOTSTRAP_TOOL_NAMES[1]!];
    const visibility = createSessionVisibility({
      mode: 'session',
      bootstrapToolNames: subset,
    });
    const tool = createListRevealedToolsBootstrap({ visibility });

    const line = parseLine(await tool.invoke({}));
    expect(line.bootstrapTools).toEqual([...subset].sort());
    expect(line.revealed).toEqual([]);
    expect(line.total).toBe(subset.length);
  });
});
