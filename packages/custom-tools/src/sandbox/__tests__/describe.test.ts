import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ToolManifest } from '../../manifest/import.js';
import { describeTool } from '../runner.js';

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

describe('describeTool', () => {
  it('returns the inputSchema object for a valid tool', async () => {
    const outcome = await describeTool(manifest('returns.ts'));
    expect(outcome).toEqual({
      outcome: 'ok',
      inputSchema: {
        type: 'object',
        properties: { who: { type: 'string' } },
        required: ['who'],
        additionalProperties: false,
      },
    });
  });

  it('returns the schema without invoking the handler (a hanging handler still describes)', async () => {
    // hangs.ts has a valid schema but a handler that never resolves. If describe
    // invoked the handler it would hit the timeout; instead it resolves the schema.
    const outcome = await describeTool(manifest('hangs.ts', { timeoutMs: 1000 }));
    expect(outcome).toEqual({
      outcome: 'ok',
      inputSchema: { type: 'object', additionalProperties: true },
    });
  });

  it('reports invalid-handler when the default export is not a function', async () => {
    // The gateway must not advertise an uncallable tool: describe confirms a
    // function default export exists (without invoking it) before returning.
    const outcome = await describeTool(manifest('bad-handler.ts'));
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('invalid-handler');
    }
  });

  it('reports invalid-schema when inputSchema is not an object', async () => {
    const outcome = await describeTool(manifest('invalid-schema.ts'));
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('invalid-schema');
    }
  });

  it('reports load-error when the entry file cannot be imported', async () => {
    const outcome = await describeTool(manifest('does-not-exist.ts'));
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.code).toBe('load-error');
    }
  });

  it('resolves a relative entry via configDir', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const { importTool } = await import('../../manifest/import.js');

    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-describe-cfg-'));
    const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-describe-src-'));
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
      expect(path.isAbsolute(imported.entry)).toBe(false);

      const outcome = await describeTool(imported, { configDir });
      expect(outcome).toEqual({
        outcome: 'ok',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
      });
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(srcDir, { recursive: true, force: true });
    }
  });
});
