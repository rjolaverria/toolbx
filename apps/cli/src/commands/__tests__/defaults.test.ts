import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultServeDetachDeps } from '../serve-detach.js';
import { defaultStopDeps } from '../stop.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  vi.restoreAllMocks();
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('defaultStopDeps', () => {
  it('wires up safe defaults that can be exercised end-to-end', async () => {
    const deps = defaultStopDeps();
    const dir = await makeTempDir('toolbx-stop-defaults-');
    const stateFile = path.join(dir, 'serve-state.json');

    expect(typeof deps.resolvePath()).toBe('string');

    const paths = deps.resolveDaemonPaths(path.join(dir, 'config.json'));
    expect(paths.statePath).toContain(dir);
    expect(paths.logPath).toContain(dir);

    expect(await deps.readState(stateFile)).toBeNull();
    await deps.clearState(stateFile); // no-op when missing
    expect(deps.isProcessAlive(process.pid)).toBe(true);

    // Verify the default kill arrow forwards to process.kill without actually
    // signaling anything — spy and assert.
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    deps.kill(process.pid, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    killSpy.mockRestore();

    await deps.sleep(1);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    deps.stdout('out\n');
    deps.stderr('err\n');
    expect(stdoutSpy).toHaveBeenCalledWith('out\n');
    expect(stderrSpy).toHaveBeenCalledWith('err\n');
  });
});

describe('defaultServeDetachDeps', () => {
  it('wires up safe defaults that can be exercised end-to-end', async () => {
    const deps = defaultServeDetachDeps();
    const dir = await makeTempDir('toolbx-serve-detach-defaults-');
    const stateFile = path.join(dir, 'serve-state.json');
    const logFile = path.join(dir, 'serve.log');

    expect(typeof deps.resolvePath()).toBe('string');

    const paths = deps.resolveDaemonPaths(path.join(dir, 'config.json'));
    expect(paths.statePath).toContain(dir);
    expect(paths.logPath).toContain(dir);

    expect(await deps.readState(stateFile)).toBeNull();
    await deps.clearState(stateFile);
    expect(deps.isProcessAlive(process.pid)).toBe(true);

    const fd = await deps.openLogFd(logFile);
    expect(Number.isInteger(fd)).toBe(true);
    await deps.closeFd(fd);
    // closing twice is safe
    await deps.closeFd(fd);

    expect(typeof deps.nodeExecPath()).toBe('string');
    expect(deps.processEnv).toBe(process.env);
    expect(typeof deps.now()).toBe('number');
    // The endpoint is closed, so the readiness probe resolves false rather than throwing.
    expect(await deps.probeReady('http://127.0.0.1:1/mcp')).toBe(false);

    // Verify the default kill arrow forwards to process.kill without actually
    // signaling anything — spy and assert.
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    deps.kill(process.pid, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    killSpy.mockRestore();

    // The default entry script resolver reads process.argv[1]; it is guaranteed
    // to be a non-empty string in any normal Node run (vitest passes its own
    // CLI entry), so the function should not throw.
    expect(typeof deps.resolveEntryScript()).toBe('string');

    await deps.sleep(1);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    deps.stdout('out\n');
    deps.stderr('err\n');
    expect(stdoutSpy).toHaveBeenCalledWith('out\n');
    expect(stderrSpy).toHaveBeenCalledWith('err\n');
  });

  it('resolveEntryScript throws when process.argv[1] is empty', () => {
    const deps = defaultServeDetachDeps();
    const original = process.argv[1];
    try {
      // Simulate an unusual launch where argv[1] is missing/empty.
      process.argv[1] = '';
      expect(() => deps.resolveEntryScript()).toThrow(/process\.argv\[1\] is empty/);
    } finally {
      process.argv[1] = original ?? '';
    }
  });
});
