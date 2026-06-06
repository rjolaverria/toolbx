import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { describe, expect, it } from 'vitest';

import type { ToolManifest } from '../../manifest/import.js';
import { killProcessTree, wrapSpawn } from '../os-sandbox.js';
import { runTool } from '../runner.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const SUPPORTED =
  SandboxManager.isSupportedPlatform() && SandboxManager.checkDependencies().errors.length === 0;
const maybe = SUPPORTED ? it : it.skip;

describe('OS sandbox boundary (skipped on unsupported hosts)', () => {
  maybe('contains a filesystem write that bypasses the harness seal', async () => {
    const fixture = path.join(FIXTURES, 'os-escape-write.mjs');
    const { argv, env, sandboxed } = await wrapSpawn({
      argv: [process.execPath, fixture],
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

  maybe('denies writes to srt default writable paths for filesystem:false', async () => {
    // srt always re-adds its default writable paths (e.g. /tmp/claude); the
    // wrapper must deny them so filesystem:false truly means no writes. The
    // parent creates the dir so the failure is the sandbox (EPERM), not ENOENT.
    const dir = '/tmp/claude';
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `toolbox-escape-${String(process.pid)}.txt`);
    fs.rmSync(target, { force: true });
    try {
      const fixture = path.join(FIXTURES, 'os-escape-write.mjs');
      const { argv, env } = await wrapSpawn({
        argv: [process.execPath, fixture],
        permissions: { network: false, filesystem: false, env: [] },
      });
      const [cmd, ...rest] = argv;
      const child = spawn(cmd as string, rest, {
        env,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const message = await new Promise<{ write: string }>((resolve, reject) => {
        child.on('message', (m) => resolve(m as { write: string }));
        child.on('error', reject);
        child.on('close', () => reject(new Error('child closed without a message')));
        child.send({ target });
      });
      expect(message.write).toContain('BLOCKED');
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  maybe('contains a filesystem read of a home secret that bypasses the harness seal', async () => {
    const secret = path.join(os.homedir(), `.toolbox-os-escape-read-${String(process.pid)}.txt`);
    fs.writeFileSync(secret, 'top-secret');
    try {
      const fixture = path.join(FIXTURES, 'os-escape-read.mjs');
      const { argv, env, sandboxed } = await wrapSpawn({
        argv: [process.execPath, fixture],
        permissions: { network: false, filesystem: false, env: [] },
      });
      expect(sandboxed).toBe(true);

      const [cmd, ...rest] = argv;
      const child = spawn(cmd as string, rest, {
        env,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const message = await new Promise<{ read: string }>((resolve, reject) => {
        child.on('message', (m) => resolve(m as { read: string }));
        child.on('error', reject);
        child.on('close', () => reject(new Error('child closed without a message')));
        child.send({ target: secret });
      });

      expect(message.read).toContain('BLOCKED');
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  maybe('kills the whole sandboxed process tree, not just the wrapper shell', async () => {
    // After wrapping, the direct child is the bash → sandbox-exec wrapper; the
    // fixture's reported PID is the Node process underneath. killProcessTree must
    // reap that whole group, not just the shell.
    const fixture = path.join(FIXTURES, 'os-hang.mjs');
    const { argv, env, sandboxed } = await wrapSpawn({
      argv: [process.execPath, fixture],
      permissions: { network: false, filesystem: false, env: [] },
    });
    expect(sandboxed).toBe(true);

    const [cmd, ...rest] = argv;
    const child = spawn(cmd as string, rest, {
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      detached: true,
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.on('message', (m) => resolve((m as { pid: number }).pid));
      child.on('error', reject);
      child.on('close', () => reject(new Error('child closed without a message')));
      child.send({});
    });
    expect(isAlive(pid)).toBe(true);

    killProcessTree(child);
    for (let i = 0; i < 50 && isAlive(pid); i++) {
      await delay(100);
    }
    expect(isAlive(pid)).toBe(false);
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

  maybe('does not let an allowlisted BASH_ENV run code in the wrapper shell', async () => {
    // BASH_ENV makes non-interactive bash source a file at startup. If the tool's
    // allowlisted env reached the wrapper shell, this would run *outside* the OS
    // sandbox. The marker must never be created.
    const marker = path.join(os.tmpdir(), `toolbox-bashenv-pwned-${String(process.pid)}.txt`);
    const evil = path.join(os.tmpdir(), `toolbox-evil-${String(process.pid)}.sh`);
    fs.writeFileSync(evil, `touch ${marker}\n`);
    fs.rmSync(marker, { force: true });
    const previous = process.env.BASH_ENV;
    process.env.BASH_ENV = evil;
    try {
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
        permissions: { network: false, filesystem: false, env: ['BASH_ENV'] },
      };
      const outcome = await runTool(
        manifest,
        { who: 'world' },
        { sandbox: { mode: 'auto', require: true } },
      );
      expect(outcome.outcome).toBe('ok');
      await delay(200);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.BASH_ENV;
      } else {
        process.env.BASH_ENV = previous;
      }
      fs.rmSync(evil, { force: true });
      fs.rmSync(marker, { force: true });
    }
  });
});
