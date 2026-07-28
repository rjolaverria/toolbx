import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolManifest } from '../../manifest/import.js';

// Drive the timeout logic against a fake child so the two phases (startup guard vs
// per-tool operation timeout) can be exercised deterministically with fake timers —
// the real sandbox cannot inject controlled cold-start latency. `spawn` is the only
// child_process function replaced; everything else stays real.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

// Imported after the mock is registered so the runner binds the mocked `spawn`.
const { runTool } = await import('../runner.js');

/**
 * Minimal stand-in for the spawned child. `pid: undefined` steers `finish` down the
 * no-kill cleanup path (no real process to SIGKILL), and the EventEmitter base lets a
 * test emit `message` events to the runner's IPC handler.
 */
class FakeChild extends EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly sent: unknown[] = [];
  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
  kill(): boolean {
    return true;
  }
}

function manifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: 'timeout-fixture',
    namespace: 'test',
    exposedName: 'test__timeout_fixture',
    title: 'timeout fixture',
    description: 'timeout fixture',
    entry: '/tmp/does-not-need-to-exist.ts',
    runtime: 'node',
    enabled: true,
    timeoutMs: 500,
    permissions: { network: false, filesystem: false, env: [] },
    ...overrides,
  };
}

// Sandbox off so `wrapSpawn` returns immediately (no OS-sandbox probe) and `spawn`
// is called with the plain argv, hitting our mock.
const OFF = { sandbox: { mode: 'off' as const, require: false } };

// Flush the microtasks that resolve `wrapSpawn` and reach `child.send(request)`.
async function untilRequestSent(child: FakeChild): Promise<string> {
  for (let i = 0; i < 10 && child.sent.length === 0; i++) {
    await Promise.resolve();
  }
  expect(child.sent).toHaveLength(1);
  return (child.sent[0] as { nonce: string }).nonce;
}

describe('runner two-phase timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not charge startup latency (spawn → ready) against the per-tool timeout', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const outcome = runTool(manifest({ timeoutMs: 500 }), {}, OFF);
    const nonce = await untilRequestSent(child);

    // Simulate a slow cold start: far longer than the 500ms operation budget, but
    // within the startup guard. The operation timer must not have started yet.
    await vi.advanceTimersByTimeAsync(5000);
    child.emit('message', { nonce, ready: true });
    // Tool responds promptly after ready — well inside the 500ms operation budget.
    child.emit('message', { nonce, ok: true, result: 'done' });

    await expect(outcome).resolves.toEqual({ outcome: 'ok', result: 'done' });
  });

  it('bounds tool work with the operation timeout once ready', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const outcome = runTool(manifest({ timeoutMs: 500 }), {}, OFF);
    const nonce = await untilRequestSent(child);

    child.emit('message', { nonce, ready: true });
    // No result: the 500ms operation timeout should fire.
    await vi.advanceTimersByTimeAsync(500);

    await expect(outcome).resolves.toEqual({ outcome: 'timeout' });
  });

  it('times out a child that never signals ready via the startup guard', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const outcome = runTool(manifest({ timeoutMs: 500 }), {}, OFF);
    await untilRequestSent(child);

    // Never ready. The 500ms operation budget alone must not fire; only the longer
    // startup guard bounds a wedged spawn.
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(15000);

    await expect(outcome).resolves.toEqual({ outcome: 'timeout' });
  });

  it('ignores a ready message carrying the wrong nonce', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const outcome = runTool(manifest({ timeoutMs: 500 }), {}, OFF);
    const nonce = await untilRequestSent(child);

    // A forged ready cannot start (or extend) the operation timer.
    child.emit('message', { nonce: 'not-the-nonce', ready: true });
    await vi.advanceTimersByTimeAsync(500);
    // Still only the startup guard is armed, so no timeout yet.
    child.emit('message', { nonce, ready: true });
    child.emit('message', { nonce, ok: true, result: 'done' });

    await expect(outcome).resolves.toEqual({ outcome: 'ok', result: 'done' });
  });
});
