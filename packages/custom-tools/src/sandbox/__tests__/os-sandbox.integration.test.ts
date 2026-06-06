import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { describe, expect, it } from 'vitest';

import type { ToolManifest } from '../../manifest/import.js';
import { wrapSpawn } from '../os-sandbox.js';
import { runTool } from '../runner.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const SUPPORTED =
  SandboxManager.isSupportedPlatform() && SandboxManager.checkDependencies().errors.length === 0;
const maybe = SUPPORTED ? it : it.skip;

describe('OS sandbox boundary (skipped on unsupported hosts)', () => {
  maybe('contains a filesystem write that bypasses the harness seal', async () => {
    const fixture = path.join(FIXTURES, 'os-escape-write.mjs');
    const { argv, env, sandboxed } = await wrapSpawn({
      argv: [process.execPath, fixture],
      env: {},
      permissions: { network: false, filesystem: false, env: [] },
    });
    expect(sandboxed).toBe(true);

    const [cmd, ...rest] = argv;
    const child = spawn(cmd as string, rest, {
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const target = path.join(os.homedir(), `.toolbox-os-escape-${String(process.pid)}.txt`);

    const message = await new Promise<{ write: string }>((resolve, reject) => {
      child.on('message', (m) => resolve(m as { write: string }));
      child.on('error', reject);
      child.on('close', () => reject(new Error('child closed without a message')));
      child.send({ target });
    });

    expect(message.write).toContain('BLOCKED');
    expect(fs.existsSync(target)).toBe(false);
  });

  maybe('runs a normal custom tool end-to-end under the sandbox (IPC survives)', async () => {
    const manifest: ToolManifest = {
      name: 'returns',
      namespace: 'test',
      exposedName: 'test__returns',
      title: 'returns',
      description: 'returns',
      entry: path.join(FIXTURES, 'returns.ts'),
      runtime: 'node',
      enabled: true,
      timeoutMs: 5000,
      permissions: { network: false, filesystem: false, env: [] },
    };
    const outcome = await runTool(
      manifest,
      { who: 'world' },
      { sandbox: { mode: 'auto', require: true } },
    );
    expect(outcome).toEqual({
      outcome: 'ok',
      result: { content: [{ type: 'text', text: 'Hello world' }] },
    });
  });
});
