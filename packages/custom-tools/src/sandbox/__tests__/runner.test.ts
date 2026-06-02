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
});
