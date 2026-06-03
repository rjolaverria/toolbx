import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createNoopLogger, type RegisteredToolView } from '@toolbox/core';
import type { DescribeOutcome, RunOutcome, ToolManifest } from '@toolbox/custom-tools';
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
});
