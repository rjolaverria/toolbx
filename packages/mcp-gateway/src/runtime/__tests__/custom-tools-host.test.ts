import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createNoopLogger, type RegisteredToolView } from '@rjolaverria/toolbox-core';
import type { DescribeOutcome, RunOutcome, ToolManifest } from '@rjolaverria/toolbox-custom-tools';
import { describe, expect, it, vi } from 'vitest';

import { createCustomToolHost, CUSTOM_TOOL_META_KEY } from '../custom-tools-host.js';

const CONFIG_DIR = '/cfg';

function manifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: 'echo',
    namespace: 'personal',
    exposedName: 'personal__echo',
    title: 'Echo',
    description: 'Echoes input',
    entry: 'tools/personal/echo.ts',
    runtime: 'node',
    enabled: true,
    timeoutMs: 30_000,
    permissions: { network: false, filesystem: false, env: [] },
    ...overrides,
  };
}

function view(m: ToolManifest, tool: Tool): RegisteredToolView {
  return {
    exposedName: m.exposedName,
    serverName: m.namespace,
    upstreamName: m.name,
    tool,
    source: 'custom',
  };
}

const SCHEMA = { type: 'object', properties: { who: { type: 'string' } } };

function deps(overrides: Partial<Parameters<typeof createCustomToolHost>[0]> = {}) {
  return {
    configDir: CONFIG_DIR,
    logger: createNoopLogger(),
    enabledServerNames: new Set<string>(),
    separator: '__',
    readManifest: vi.fn((): Promise<ToolManifest[]> => Promise.resolve([manifest()])),
    describe: vi.fn(
      (): Promise<DescribeOutcome> => Promise.resolve({ outcome: 'ok', inputSchema: SCHEMA }),
    ),
    run: vi.fn(
      (): Promise<RunOutcome> => Promise.resolve({ outcome: 'ok', result: { content: [] } }),
    ),
    ...overrides,
  };
}

describe('createCustomToolHost', () => {
  it('loads enabled custom tools with their resolved schema as registry inputs', async () => {
    const host = createCustomToolHost(deps());
    const inputs = await host.load();
    expect(inputs).toEqual([
      {
        exposedName: 'personal__echo',
        namespace: 'personal',
        name: 'echo',
        tool: {
          name: 'personal__echo',
          title: 'Echo',
          description: 'Echoes input',
          inputSchema: SCHEMA,
          _meta: { [CUSTOM_TOOL_META_KEY]: true },
        },
      },
    ]);
  });

  it('exposes the exact manifest snapshot it read via manifestSnapshot', async () => {
    const entries = [
      manifest(),
      manifest({ name: 'greet', exposedName: 'personal__greet', enabled: false }),
    ];
    const host = createCustomToolHost(
      deps({ readManifest: vi.fn((): Promise<ToolManifest[]> => Promise.resolve(entries)) }),
    );
    await host.load();
    expect(await host.manifestSnapshot).toEqual(entries);
  });

  it('resolves manifestSnapshot to [] when the manifest is unreadable', async () => {
    const host = createCustomToolHost(
      deps({
        readManifest: vi.fn((): Promise<ToolManifest[]> => Promise.reject(new Error('corrupt'))),
      }),
    );
    await host.load();
    expect(await host.manifestSnapshot).toEqual([]);
  });

  it('describes eligible tools concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const describe = vi.fn(async (): Promise<DescribeOutcome> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { outcome: 'ok', inputSchema: SCHEMA };
    });
    const entries = [
      manifest({ name: 'a', exposedName: 'personal__a', entry: 'tools/personal/a.ts' }),
      manifest({ name: 'b', exposedName: 'personal__b', entry: 'tools/personal/b.ts' }),
      manifest({ name: 'c', exposedName: 'personal__c', entry: 'tools/personal/c.ts' }),
    ];
    const host = createCustomToolHost(
      deps({
        readManifest: vi.fn((): Promise<ToolManifest[]> => Promise.resolve(entries)),
        describe,
      }),
    );
    const inputs = await host.load();
    expect(inputs).toHaveLength(3);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('registers each tool incrementally via onRegistered as describes resolve', async () => {
    // a resolves fast; b is slow. The fast one must be registered before the slow
    // one settles, not held back until both finish.
    const describe = vi.fn((m: ToolManifest): Promise<DescribeOutcome> => {
      const delayMs = m.name === 'b' ? 80 : 0;
      return new Promise((resolve) =>
        setTimeout(() => resolve({ outcome: 'ok', inputSchema: SCHEMA }), delayMs),
      );
    });
    const entries = [
      manifest({ name: 'a', exposedName: 'personal__a', entry: 'tools/personal/a.ts' }),
      manifest({ name: 'b', exposedName: 'personal__b', entry: 'tools/personal/b.ts' }),
    ];
    const host = createCustomToolHost(
      deps({
        readManifest: vi.fn((): Promise<ToolManifest[]> => Promise.resolve(entries)),
        describe,
      }),
    );
    const sizes: number[] = [];
    await host.load((inputs) => sizes.push(inputs.length));
    // Two progress calls (one per tool), the first before the second.
    expect(sizes).toEqual([1, 2]);
  });

  it('skips disabled tools', async () => {
    const host = createCustomToolHost(
      deps({
        readManifest: vi.fn(
          (): Promise<ToolManifest[]> => Promise.resolve([manifest({ enabled: false })]),
        ),
      }),
    );
    expect(await host.load()).toEqual([]);
  });

  it('skips a tool whose namespace collides with an enabled server', async () => {
    const describeFn = vi.fn(
      (): Promise<DescribeOutcome> => Promise.resolve({ outcome: 'ok', inputSchema: SCHEMA }),
    );
    const host = createCustomToolHost(
      deps({ enabledServerNames: new Set(['personal']), describe: describeFn }),
    );
    expect(await host.load()).toEqual([]);
    // The collision is decided before describing, so the sandbox is never spawned.
    expect(describeFn).not.toHaveBeenCalled();
  });

  it('skips a custom tool that uses the reserved "toolbox" namespace', async () => {
    const describeFn = vi.fn(
      (): Promise<DescribeOutcome> => Promise.resolve({ outcome: 'ok', inputSchema: SCHEMA }),
    );
    const host = createCustomToolHost(
      deps({
        readManifest: vi.fn(
          (): Promise<ToolManifest[]> =>
            Promise.resolve([
              manifest({
                namespace: 'toolbox',
                name: 'search_tools',
                exposedName: 'toolbox__search_tools',
                entry: 'tools/toolbox/search_tools.ts',
              }),
            ]),
        ),
        describe: describeFn,
      }),
    );
    expect(await host.load()).toEqual([]);
    expect(describeFn).not.toHaveBeenCalled();
  });

  it('skips a tool whose stored exposedName does not match namespace + separator + name', async () => {
    const describeFn = vi.fn(
      (): Promise<DescribeOutcome> => Promise.resolve({ outcome: 'ok', inputSchema: SCHEMA }),
    );
    const host = createCustomToolHost(
      // namespace/name resolve to personal__echo, but a hand-edited exposedName
      // claims an upstream name — it must not be allowed to shadow that entry.
      deps({
        readManifest: vi.fn(
          (): Promise<ToolManifest[]> =>
            Promise.resolve([manifest({ exposedName: 'github__create_issue' })]),
        ),
        describe: describeFn,
      }),
    );
    expect(await host.load()).toEqual([]);
    expect(describeFn).not.toHaveBeenCalled();
  });

  it('skips a tool whose manifest entry escapes the canonical storage path', async () => {
    const describeFn = vi.fn(
      (): Promise<DescribeOutcome> => Promise.resolve({ outcome: 'ok', inputSchema: SCHEMA }),
    );
    const host = createCustomToolHost(
      // entry points at a different file than the record's namespace/name imply —
      // resolveToolEntryPath rejects it, so it is never described or runnable.
      deps({
        readManifest: vi.fn(
          (): Promise<ToolManifest[]> =>
            Promise.resolve([manifest({ entry: 'tools/personal/tampered.ts' })]),
        ),
        describe: describeFn,
      }),
    );
    expect(await host.load()).toEqual([]);
    expect(describeFn).not.toHaveBeenCalled();
  });

  it('skips a tool whose schema cannot be resolved', async () => {
    const host = createCustomToolHost(
      deps({
        describe: vi.fn(
          (): Promise<DescribeOutcome> =>
            Promise.resolve({ outcome: 'error', code: 'invalid-schema', message: 'bad' }),
        ),
      }),
    );
    expect(await host.load()).toEqual([]);
  });

  it('returns [] when the manifest is unreadable rather than throwing', async () => {
    const host = createCustomToolHost(
      deps({
        readManifest: vi.fn(
          (): Promise<ToolManifest[]> => Promise.reject(new Error('corrupt manifest')),
        ),
      }),
    );
    expect(await host.load()).toEqual([]);
  });

  it('executor runs the tool and maps an ok outcome to kind: ok', async () => {
    const result = { content: [{ type: 'text', text: 'hi' }] };
    const runFn = vi.fn((): Promise<RunOutcome> => Promise.resolve({ outcome: 'ok', result }));
    const d = deps({ run: runFn });
    const host = createCustomToolHost(d);
    const [input] = await host.load();
    const v = view(manifest(), input!.tool);

    const outcome = await host.executor.run(v, { who: 'world' });
    expect(outcome).toEqual({ kind: 'ok', result });
    expect(runFn).toHaveBeenCalledWith(
      expect.objectContaining({ exposedName: 'personal__echo' }),
      { who: 'world' },
      expect.objectContaining({ configDir: CONFIG_DIR }),
    );
  });

  it('executor forwards the abort signal to run', async () => {
    const runFn = vi.fn(
      (): Promise<RunOutcome> => Promise.resolve({ outcome: 'ok', result: { content: [] } }),
    );
    const host = createCustomToolHost(deps({ run: runFn }));
    const [input] = await host.load();
    const controller = new AbortController();
    await host.executor.run(view(manifest(), input!.tool), {}, controller.signal);
    expect(runFn).toHaveBeenCalledWith(
      expect.objectContaining({ exposedName: 'personal__echo' }),
      {},
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('executor maps an invalid CallToolResult to an upstream_error', async () => {
    const host = createCustomToolHost(
      deps({
        // `content` must be an array of content blocks — a string is malformed.
        run: vi.fn(
          (): Promise<RunOutcome> =>
            Promise.resolve({ outcome: 'ok', result: { content: 'not-an-array' } }),
        ),
      }),
    );
    const [input] = await host.load();
    const outcome = await host.executor.run(view(manifest(), input!.tool), {});
    expect(outcome).toMatchObject({
      kind: 'upstream_error',
      error: { code: 'upstream', server: 'personal', tool: 'echo' },
    });
  });

  it('executor maps a timeout outcome to an upstream_error timeout', async () => {
    const host = createCustomToolHost(
      deps({ run: vi.fn((): Promise<RunOutcome> => Promise.resolve({ outcome: 'timeout' })) }),
    );
    const [input] = await host.load();
    const outcome = await host.executor.run(view(manifest(), input!.tool), {});
    expect(outcome).toMatchObject({
      kind: 'upstream_error',
      error: { code: 'timeout', server: 'personal', tool: 'echo', timeoutMs: 30_000 },
    });
  });

  it('executor maps an invalid-args error to kind: invalid_args', async () => {
    const host = createCustomToolHost(
      deps({
        run: vi.fn(
          (): Promise<RunOutcome> =>
            Promise.resolve({
              outcome: 'error',
              code: 'invalid-args',
              message: 'arguments do not match inputSchema',
            }),
        ),
      }),
    );
    const [input] = await host.load();
    const outcome = await host.executor.run(view(manifest(), input!.tool), {});
    expect(outcome).toMatchObject({ kind: 'invalid_args' });
  });

  it('executor maps a tool-error to an upstream_error', async () => {
    const host = createCustomToolHost(
      deps({
        run: vi.fn(
          (): Promise<RunOutcome> =>
            Promise.resolve({ outcome: 'error', code: 'tool-error', message: 'boom' }),
        ),
      }),
    );
    const [input] = await host.load();
    const outcome = await host.executor.run(view(manifest(), input!.tool), {});
    expect(outcome).toMatchObject({
      kind: 'upstream_error',
      error: { code: 'upstream', server: 'personal', tool: 'echo', message: 'boom' },
    });
  });

  it('executor returns unknown_tool for a view that was never loaded', async () => {
    const host = createCustomToolHost(deps());
    // No load() call, so the manifest map is empty.
    const outcome = await host.executor.run(
      view(manifest(), { name: 'personal__echo', inputSchema: { type: 'object' } }),
      {},
    );
    expect(outcome).toEqual({ kind: 'unknown_tool' });
  });

  it('forwards the sandbox option into the run and describe seams', async () => {
    const sandbox = { mode: 'auto' as const, require: true };
    const runFn = vi.fn(
      (): Promise<RunOutcome> => Promise.resolve({ outcome: 'ok', result: { content: [] } }),
    );
    const describeFn = vi.fn(
      (): Promise<DescribeOutcome> => Promise.resolve({ outcome: 'ok', inputSchema: SCHEMA }),
    );
    const host = createCustomToolHost(deps({ run: runFn, describe: describeFn, sandbox }));
    const [input] = await host.load();
    await host.executor.run(view(manifest(), input!.tool), {});

    expect(describeFn).toHaveBeenCalledWith(
      expect.objectContaining({ exposedName: 'personal__echo' }),
      expect.objectContaining({ sandbox }),
    );
    expect(runFn).toHaveBeenCalledWith(
      expect.objectContaining({ exposedName: 'personal__echo' }),
      {},
      expect.objectContaining({ sandbox }),
    );
  });
});
