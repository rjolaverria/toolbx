import type { DaemonClient } from '@toolbox/core';
import { describe, expect, it } from 'vitest';

import { awaitColdStartTools, type RunDeps } from '../run-shared.js';

type Listed = Awaited<ReturnType<DaemonClient['listTools']>>;

function listing(...names: string[]): Listed {
  return { tools: names.map((name) => ({ name, inputSchema: { type: 'object' as const } })) };
}

/** Minimal deps: the helper only reads `delay`. */
const deps = { delay: () => Promise.resolve() } as unknown as RunDeps;

function fakeClient(sequence: Listed[]): { listTools: () => Promise<Listed>; calls: () => number } {
  let i = 0;
  let calls = 0;
  return {
    calls: () => calls,
    listTools: () => {
      calls += 1;
      const next = sequence[Math.min(i, sequence.length - 1)] ?? listing();
      i += 1;
      return Promise.resolve(next);
    },
  };
}

describe('awaitColdStartTools', () => {
  it('returns the initial listing unchanged for a reused daemon', async () => {
    const client = fakeClient([listing('personal__echo')]);
    const initial = listing();
    const result = await awaitColdStartTools(
      client as never,
      ['personal__echo'],
      initial,
      true,
      deps,
    );
    expect(result).toBe(initial);
    expect(client.calls()).toBe(0);
  });

  it('returns immediately when the tool is already present', async () => {
    const client = fakeClient([listing('personal__echo')]);
    const initial = listing('personal__echo');
    const result = await awaitColdStartTools(
      client as never,
      ['personal__echo'],
      initial,
      false,
      deps,
    );
    expect(result).toBe(initial);
    expect(client.calls()).toBe(0);
  });

  it('polls a cold-started daemon until the tool appears', async () => {
    const client = fakeClient([listing(), listing('personal__echo')]);
    const result = await awaitColdStartTools(
      client as never,
      ['personal__echo'],
      listing(),
      false,
      deps,
    );
    expect(result.tools.map((t) => t.name)).toContain('personal__echo');
    expect(client.calls()).toBeGreaterThanOrEqual(1);
  });

  it('gives up after the budget when the tool never appears', async () => {
    const sleeps: number[] = [];
    const slowDeps = {
      delay: (ms: number) => {
        sleeps.push(ms);
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    } as unknown as RunDeps;
    const client = fakeClient([listing()]);
    const result = await awaitColdStartTools(
      client as never,
      ['personal__missing'],
      listing(),
      false,
      slowDeps,
    );
    expect(result.tools.map((t) => t.name)).not.toContain('personal__missing');
    expect(sleeps.length).toBeGreaterThan(0);
  }, 10_000);
});
