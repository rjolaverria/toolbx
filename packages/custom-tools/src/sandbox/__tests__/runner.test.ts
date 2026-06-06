import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { ToolManifest } from '../../manifest/import.js';
import type { PlatformProbe } from '../os-sandbox.js';
import { runTool } from '../runner.js';

const unsupportedProbe: PlatformProbe = {
  isSupportedPlatform: () => false,
  checkDependencies: () => ({ warnings: [], errors: [] }),
  wrapWithSandboxArgv: () => Promise.resolve({ argv: [], env: {} }),
  cleanupAfterCommand: () => {},
};

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function manifest(file: string, overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: file.replace(/\.ts$/, ''),
    namespace: 'test',
    exposedName: `test__${file.replace(/\.ts$/, '')}`,
    title: file,
    description: file,
    entry: path.join(FIXTURES, file),
    runtime: 'node',
    enabled: true,
    timeoutMs: 5000,
    permissions: { network: false, filesystem: false, env: [] },
    ...overrides,
  };
}

describe('runTool', () => {
  it('returns the handler result within the timeout', async () => {
    const outcome = await runTool(manifest('returns.ts'), { who: 'world' });
    expect(outcome).toEqual({
      outcome: 'ok',
      result: { content: [{ type: 'text', text: 'Hello world' }] },
    });
  });

  it('kills a tool that exceeds its timeout and reports timeout', async () => {
    const outcome = await runTool(manifest('hangs.ts', { timeoutMs: 200 }), {});
    expect(outcome).toEqual({ outcome: 'timeout' });
  });

  it('aborts a running tool when the signal fires, before the timeout', async () => {
    const controller = new AbortController();
    const promise = runTool(
      manifest('hangs.ts', { timeoutMs: 5000 }),
      {},
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    const outcome = await promise;
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.message).toContain('aborted');
    }
  });

  it('returns an error immediately for an already-aborted signal', async () => {
    const outcome = await runTool(
      manifest('returns.ts'),
      { who: 'x' },
      { signal: AbortSignal.abort() },
    );
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.message).toContain('aborted');
    }
  });

  it('blocks fetch when network is denied', async () => {
    const outcome = await runTool(manifest('fetches.ts'), {});
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('tool-error');
      expect(outcome.message).toContain('network access is disabled');
    }
  });

  it('exposes only allowlisted env vars to the tool', async () => {
    process.env.SLACK_BOT_TOKEN = 'tok-allow';
    process.env.SECRET_OTHER = 'tok-deny';
    try {
      const outcome = await runTool(
        manifest('reads-env.ts', {
          permissions: { network: false, filesystem: false, env: ['SLACK_BOT_TOKEN'] },
        }),
        {},
      );
      expect(outcome.outcome).toBe('ok');
      const keys = JSON.parse(
        (outcome as { result: { content: { text: string }[] } }).result.content[0]!.text,
      ) as string[];
      expect(keys).toContain('SLACK_BOT_TOKEN');
      expect(keys).not.toContain('SECRET_OTHER');
      // The OS-sandbox wrapper needs PATH/HOME in the shared process env and Node
      // injects NODE_CHANNEL_FD for the IPC channel, but the harness prunes both
      // from the tool's view, so a sandboxed tool sees the same allowlist a
      // non-sandboxed one does.
      expect(keys).not.toContain('PATH');
      expect(keys).not.toContain('HOME');
      expect(keys).not.toContain('NODE_CHANNEL_FD');
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SECRET_OTHER;
    }
  });

  it('redacts allowlisted secret values from the audit log and outcome', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-12345-secret';
    const records: Record<string, unknown>[] = [];
    const logger = {
      info: (obj: Record<string, unknown>) => records.push(obj),
      warn: (obj: Record<string, unknown>) => records.push(obj),
    };
    try {
      const outcome = await runTool(
        manifest('leaks-secret.ts', {
          permissions: { network: false, filesystem: false, env: ['SLACK_BOT_TOKEN'] },
        }),
        {},
        { logger: logger as never },
      );
      expect(outcome.outcome).toBe('error');
      if (outcome.outcome === 'error') {
        expect(outcome.message).not.toContain('xoxb-12345-secret');
        expect(outcome.message).toContain('***');
      }
      // The audit record must carry only safe fields — never the raw (or even redacted)
      // tool message — so a secret cannot leak through the structured log at all.
      expect(records).toHaveLength(1);
      const record = records[0] ?? {};
      expect(JSON.stringify(record)).not.toContain('xoxb-12345-secret');
      expect(record).not.toHaveProperty('message');
      expect(record).toMatchObject({
        tool: 'test__leaks-secret',
        outcome: 'error',
        errorCode: 'tool-error',
      });
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('reports invalid-handler when the default export is not a function', async () => {
    const outcome = await runTool(manifest('bad-handler.ts'), {});
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('invalid-handler');
    }
  });

  it('reports invalid-args when args violate the schema', async () => {
    const outcome = await runTool(manifest('returns.ts'), { who: 123 });
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('invalid-args');
    }
  });

  it('reports invalid-schema when inputSchema is not a valid JSON Schema', async () => {
    const outcome = await runTool(manifest('invalid-schema.ts'), {});
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('invalid-schema');
    }
  });

  it('reports invalid-schema when the schema errors at validation time', async () => {
    const outcome = await runTool(manifest('bad-pattern-schema.ts'), { x: 'abc' });
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('invalid-schema');
    }
  });

  it('reports load-error when the entry file cannot be imported', async () => {
    const outcome = await runTool(manifest('does-not-exist.ts'), {});
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('load-error');
    }
  });

  it('runs a tool imported by importTool, resolving the relative entry via configDir', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const { importTool } = await import('../../manifest/import.js');

    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-runtime-cfg-'));
    const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-runtime-src-'));
    try {
      const source = `/**
 * @toolbox-tool name echo
 * @toolbox-tool title Echo
 * @toolbox-tool description Echoes a message.
 * @toolbox-tool namespace personal
 */
export const inputSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
};
export default function echo(input) {
  return { content: [{ type: 'text', text: input.message }] };
}
`;
      const srcPath = path.join(srcDir, 'echo.ts');
      await fs.writeFile(srcPath, source, 'utf8');

      const { manifest: imported } = await importTool(srcPath, { configDir });
      // entry is stored relative to the config dir, e.g. tools/personal/echo.ts
      expect(path.isAbsolute(imported.entry)).toBe(false);

      const outcome = await runTool(imported, { message: 'hi there' }, { configDir });
      expect(outcome).toEqual({
        outcome: 'ok',
        result: { content: [{ type: 'text', text: 'hi there' }] },
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(srcDir, { recursive: true, force: true });
    }
  });

  it('runs an imported ESM .js tool (tools/ is marked type:module)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const { importTool } = await import('../../manifest/import.js');

    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-js-cfg-'));
    const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-js-src-'));
    try {
      const source = `/**
 * @toolbox-tool name jsgreet
 * @toolbox-tool title JsGreet
 * @toolbox-tool description ESM JS tool.
 * @toolbox-tool namespace personal
 */
export const inputSchema = {
  type: 'object',
  properties: { who: { type: 'string' } },
  required: ['who'],
  additionalProperties: false,
};
export default function jsgreet(input) {
  return { content: [{ type: 'text', text: 'js ' + input.who }] };
}
`;
      const srcPath = path.join(srcDir, 'jsgreet.js');
      await fs.writeFile(srcPath, source, 'utf8');

      const { manifest: imported } = await importTool(srcPath, { configDir });
      expect(imported.entry.endsWith('.js')).toBe(true);

      const outcome = await runTool(imported, { who: 'world' }, { configDir });
      expect(outcome).toEqual({
        outcome: 'ok',
        result: { content: [{ type: 'text', text: 'js world' }] },
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(srcDir, { recursive: true, force: true });
    }
  });

  it('blocks filesystem access via process.getBuiltinModule when filesystem is denied', async () => {
    const outcome = await runTool(manifest('builtin-fs.ts'), {});
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('tool-error');
      expect(outcome.message).toContain('disabled');
    }
  });

  it('blocks network access via process.getBuiltinModule when network is denied', async () => {
    const outcome = await runTool(manifest('builtin-http.ts'), {});
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('tool-error');
      expect(outcome.message).toContain('disabled');
    }
  });

  it('runs a tool using non-erasable TypeScript (enum) via transform-types', async () => {
    const outcome = await runTool(manifest('uses-enum.ts'), {});
    expect(outcome).toEqual({
      outcome: 'ok',
      result: { content: [{ type: 'text', text: 'mode=1' }] },
    });
  });

  it('never forwards NODE_OPTIONS to the child even when allowlisted', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=64';
    process.env.SLACK_BOT_TOKEN = 'tok-allow';
    try {
      const outcome = await runTool(
        manifest('reads-env.ts', {
          permissions: {
            network: false,
            filesystem: false,
            env: ['NODE_OPTIONS', 'SLACK_BOT_TOKEN'],
          },
        }),
        {},
      );
      expect(outcome.outcome).toBe('ok');
      const keys = JSON.parse(
        (outcome as { result: { content: { text: string }[] } }).result.content[0]!.text,
      ) as string[];
      expect(keys).not.toContain('NODE_OPTIONS');
      expect(keys).toContain('SLACK_BOT_TOKEN');
    } finally {
      delete process.env.NODE_OPTIONS;
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('strips forbidden Node env vars regardless of key case', async () => {
    process.env.node_options = '--max-old-space-size=64';
    process.env.SLACK_BOT_TOKEN = 'tok-allow';
    try {
      const outcome = await runTool(
        manifest('reads-env.ts', {
          permissions: {
            network: false,
            filesystem: false,
            env: ['node_options', 'SLACK_BOT_TOKEN'],
          },
        }),
        {},
      );
      expect(outcome.outcome).toBe('ok');
      const keys = JSON.parse(
        (outcome as { result: { content: { text: string }[] } }).result.content[0]!.text,
      ) as string[];
      expect(keys.map((k) => k.toUpperCase())).not.toContain('NODE_OPTIONS');
    } finally {
      delete process.env.node_options;
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('redacts allowlisted secrets that appear in schema-derived error messages', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-secret-PATTERN';
    try {
      const outcome = await runTool(
        manifest('schema-leaks-secret.ts', {
          permissions: { network: false, filesystem: false, env: ['SLACK_BOT_TOKEN'] },
        }),
        { x: 'does-not-match' },
      );
      expect(outcome.outcome).toBe('error');
      if (outcome.outcome === 'error') {
        expect(outcome.message).not.toContain('xoxb-secret-PATTERN');
      }
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('rejects when the entry is relative and no configDir is given', async () => {
    const m = manifest('returns.ts', { entry: 'tools/test/returns.ts' });
    await expect(runTool(m, { who: 'x' })).rejects.toThrow(/configDir/);
  });

  it('emits one audit entry with tool, durationMs, and outcome', async () => {
    const records: Record<string, unknown>[] = [];
    const logger = {
      info: (obj: Record<string, unknown>) => records.push(obj),
      warn: (obj: Record<string, unknown>) => records.push(obj),
    };
    await runTool(manifest('returns.ts'), { who: 'x' }, { logger: logger as never });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tool: 'test__returns', outcome: 'ok' });
    expect(typeof records[0]?.durationMs).toBe('number');
  });

  it('blocks a generated dynamic import of node:http (string codegen disabled)', async () => {
    const outcome = await runTool(manifest('codegen-http.ts'), {});
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('tool-error');
      expect(outcome.message).toContain('Code generation from strings disallowed');
    }
  });

  it('blocks a generated dynamic import of node:fs (string codegen disabled)', async () => {
    const outcome = await runTool(manifest('codegen-fs.ts'), {});
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('tool-error');
      expect(outcome.message).toContain('Code generation from strings disallowed');
    }
  });

  it('refuses to run a stored tool that was edited to add a static builtin import', async () => {
    const outcome = await runTool(manifest('static-builtin-import.ts'), {});
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('forbidden-import');
      expect(outcome.message).toContain('node:fs');
    }
  });

  it('does not false-positive on a clean tool with no imports', async () => {
    const outcome = await runTool(manifest('returns.ts'), { who: 'world' });
    expect(outcome.outcome).toBe('ok');
  });

  it('stubs process.kill so a tool cannot signal the parent', async () => {
    const outcome = await runTool(manifest('calls-process-kill.ts'), {});
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('tool-error');
      expect(outcome.message).toContain('disabled');
    }
    // The parent (this test process) is still alive to make this assertion.
    expect(process.pid).toBeGreaterThan(0);
  });

  it('removes process.send so a tool cannot spoof a result', async () => {
    const outcome = await runTool(manifest('spoofs-ipc.ts'), {});
    // The top-level proc.send?.(...) is a no-op (send removed), so the real flow runs and
    // returns the genuine handler result — never the spoofed { spoofed: true }.
    expect(outcome).toEqual({
      outcome: 'ok',
      result: { content: [{ type: 'text', text: 'real' }] },
    });
  });

  it('ignores forged IPC messages from tool code (nonce-authenticated)', async () => {
    const outcome = await runTool(manifest('forges-ipc.ts'), {});
    // Any forged message carries a wrong/guessed nonce and is ignored; only the harness's
    // genuine nonce-authenticated result is accepted.
    expect(outcome).toEqual({
      outcome: 'ok',
      result: { content: [{ type: 'text', text: 'genuine' }] },
    });
  });
});

describe('runTool sandbox strict mode', () => {
  it('resolves to a sandbox-unavailable error when require is set and unsupported', async () => {
    const outcome = await runTool(
      manifest('returns.ts'),
      { who: 'x' },
      { sandbox: { mode: 'auto', require: true }, sandboxProbe: unsupportedProbe },
    );
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('sandbox-unavailable');
    }
  });

  it('runs normally when mode is off (in-process only)', async () => {
    const outcome = await runTool(
      manifest('returns.ts'),
      { who: 'world' },
      { sandbox: { mode: 'off', require: false } },
    );
    expect(outcome).toEqual({
      outcome: 'ok',
      result: { content: [{ type: 'text', text: 'Hello world' }] },
    });
  });

  it('runs sandbox cleanup when aborted after wrap but before spawn', async () => {
    const controller = new AbortController();
    const cleanup = vi.fn();
    // Aborts after the wrap resolves (with a valid argv), so the runner reaches
    // the pre-spawn abort check and must still run the per-command cleanup.
    const probe: PlatformProbe = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ warnings: [], errors: [] }),
      wrapWithSandboxArgv: () => {
        controller.abort();
        return Promise.resolve({ argv: ['/bin/echo', 'hi'], env: {} });
      },
      cleanupAfterCommand: cleanup,
    };
    const outcome = await runTool(
      manifest('returns.ts'),
      { who: 'x' },
      { signal: controller.signal, sandboxProbe: probe },
    );
    expect(outcome.outcome).toBe('error');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs sandbox cleanup when the sandboxed spawn fails to start', async () => {
    const cleanup = vi.fn();
    // A wrapped argv pointing at a missing binary makes spawn emit ENOENT with no
    // PID, so finish() must run cleanup directly rather than waiting for an exit
    // event that never fires.
    const probe: PlatformProbe = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ warnings: [], errors: [] }),
      wrapWithSandboxArgv: () =>
        Promise.resolve({ argv: ['/nonexistent/toolbox-no-such-binary'], env: {} }),
      cleanupAfterCommand: cleanup,
    };
    const outcome = await runTool(manifest('returns.ts'), { who: 'x' }, { sandboxProbe: probe });
    expect(outcome.outcome).toBe('error');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('maps an unexpected sandbox setup failure to a load-error outcome (never throws)', async () => {
    const probe: PlatformProbe = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ warnings: [], errors: [] }),
      wrapWithSandboxArgv: () => Promise.reject(new Error('profile generation failed')),
      cleanupAfterCommand: () => {},
    };
    const outcome = await runTool(manifest('returns.ts'), { who: 'x' }, { sandboxProbe: probe });
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('load-error');
      expect(outcome.message).toContain('profile generation failed');
    }
  });

  it('maps an abort during sandbox wrapping to the aborted outcome', async () => {
    const controller = new AbortController();
    // Not aborted at the pre-wrap check, then aborts and rejects mid-wrap — the
    // path srt takes on Linux when its ripgrep scan is cancelled.
    const abortingProbe: PlatformProbe = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ warnings: [], errors: [] }),
      wrapWithSandboxArgv: () => {
        controller.abort();
        return Promise.reject(new Error('sandbox scan cancelled'));
      },
      cleanupAfterCommand: () => {},
    };
    const outcome = await runTool(
      manifest('returns.ts'),
      { who: 'x' },
      { signal: controller.signal, sandboxProbe: abortingProbe },
    );
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.message).toContain('aborted');
    }
  });
});
