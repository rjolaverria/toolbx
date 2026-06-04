import { DEFAULT_CONFIG, type DaemonClient, type ToolBoxConfig } from '@toolbox/core';
import { describe, expect, it } from 'vitest';

import {
  awaitColdStartAll,
  awaitColdStartTarget,
  awaitColdStartTools,
  type RunDeps,
} from '../run-shared.js';

type Listed = Awaited<ReturnType<DaemonClient['listTools']>>;

function listing(...names: string[]): Listed {
  return { tools: names.map((name) => ({ name, inputSchema: { type: 'object' as const } })) };
}

/** Minimal deps: the helper only reads `delay`. */
const deps = { delay: () => Promise.resolve() } as unknown as RunDeps;

function depsWithCustom(customs: readonly { exposedName: string; timeoutMs: number }[]): RunDeps {
  return {
    delay: () => Promise.resolve(),
    readEnabledCustomTools: () => Promise.resolve(customs),
  } as unknown as RunDeps;
}

function configDisabling(...exposedNames: string[]): ToolBoxConfig {
  const tools: ToolBoxConfig['tools'] = {};
  for (const name of exposedNames) {
    tools[name] = { enabled: false };
  }
  return { ...DEFAULT_CONFIG, tools };
}

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
      2000,
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
      2000,
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
      2000,
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
      2000,
      listing(),
      false,
      slowDeps,
    );
    expect(result.tools.map((t) => t.name)).not.toContain('personal__missing');
    expect(sleeps.length).toBeGreaterThan(0);
  }, 10_000);
});

describe('awaitColdStartTarget', () => {
  it('does not wait for a custom tool disabled via config.tools', async () => {
    const client = fakeClient([listing('personal__echo')]);
    const result = await awaitColdStartTarget(
      client as never,
      'personal__echo',
      '/cfg/config.json',
      configDisabling('personal__echo'),
      listing(),
      false,
      depsWithCustom([{ exposedName: 'personal__echo', timeoutMs: 30_000 }]),
    );
    expect(result.tools).toHaveLength(0);
    expect(client.calls()).toBe(0);
  });

  it('waits for a manifest- and config-enabled custom tool that is absent', async () => {
    const client = fakeClient([listing(), listing('personal__echo')]);
    const result = await awaitColdStartTarget(
      client as never,
      'personal__echo',
      '/cfg/config.json',
      DEFAULT_CONFIG,
      listing(),
      false,
      depsWithCustom([{ exposedName: 'personal__echo', timeoutMs: 30_000 }]),
    );
    expect(result.tools.map((t) => t.name)).toContain('personal__echo');
  });
});

describe('awaitColdStartAll', () => {
  it('excludes config-disabled custom tools from the wait set', async () => {
    // echo is disabled via config and never lists; greet does. The wait must
    // settle on greet alone rather than block on the disabled echo.
    const client = fakeClient([listing(), listing('personal__greet')]);
    const result = await awaitColdStartAll(
      client as never,
      '/cfg/config.json',
      configDisabling('personal__echo'),
      listing(),
      false,
      depsWithCustom([
        { exposedName: 'personal__echo', timeoutMs: 30_000 },
        { exposedName: 'personal__greet', timeoutMs: 30_000 },
      ]),
    );
    expect(result.tools.map((t) => t.name)).toEqual(['personal__greet']);
  });
});
