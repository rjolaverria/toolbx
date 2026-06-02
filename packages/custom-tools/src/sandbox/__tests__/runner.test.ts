import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ToolManifest } from '../../manifest/import.js';
import { runTool } from '../runner.js';

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
});
