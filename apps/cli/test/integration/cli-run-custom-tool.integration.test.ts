// Daemon-backed integration test for custom tools through `tlbx run` (P3-05,
// SPECS §6.7 criteria 4–7). Imports a custom tool with the built binary, enables
// it, then drives `tlbx run` against a real auto-started daemon — proving the
// custom tool is exposed through the gateway and callable on the source-agnostic
// `tlbx run` path, exactly like a proxied upstream tool.

import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  makeConfig,
  makeTempConfig,
  runCli,
  stopDaemon,
  type TempConfigHandle,
} from './helpers.js';

const GREET_FIXTURE = fileURLToPath(new URL('./__fixtures__/greet-tool.ts', import.meta.url));

const tempConfigs: TempConfigHandle[] = [];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `tlbx run --list` until the named tool appears. Custom-tool schemas are
 * resolved off the daemon's hot path (a sandbox spawn that completes after the
 * daemon reports ready), so the first listing can race ahead of registration —
 * the same reason upstream-backed tests poll for an upstream tool to land.
 */
async function waitForToolListed(
  target: string,
  exposedName: string,
): Promise<{ exposedName: string; source: string }> {
  const deadline = Date.now() + 30_000;
  let lastStdout = '';
  while (Date.now() < deadline) {
    const listed = await runCli(['run', '--list', '--output', 'json', '--config', target], {
      timeoutMs: 30_000,
    });
    lastStdout = listed.stdout;
    if (listed.code === 0) {
      const rows = JSON.parse(listed.stdout) as { exposedName: string; source: string }[];
      const match = rows.find((r) => r.exposedName === exposedName);
      if (match !== undefined) {
        return match;
      }
    }
    await delay(500);
  }
  throw new Error(
    `tool "${exposedName}" never appeared in tlbx run --list. Last output:\n${lastStdout}`,
  );
}

afterEach(async () => {
  for (const handle of tempConfigs) {
    await stopDaemon(handle.target);
  }
  while (tempConfigs.length > 0) {
    const handle = tempConfigs.pop();
    await handle?.cleanup();
  }
});

describe('tlbx run — custom tool through the daemon', () => {
  it('imports, enables, lists, and runs a custom tool with no upstream servers', async () => {
    const config = await makeConfig({ servers: {} });
    const handle = await makeTempConfig(config);
    tempConfigs.push(handle);

    const imported = await runCli([
      'tool',
      'import',
      GREET_FIXTURE,
      '--yes',
      '--config',
      handle.target,
    ]);
    expect(imported.code).toBe(0);

    const enabled = await runCli(['tool', 'enable', 'personal__greet', '--config', handle.target]);
    expect(enabled.code).toBe(0);

    // Discovery: the daemon auto-starts and lists the custom tool, marked custom.
    const greetRow = await waitForToolListed(handle.target, 'personal__greet');
    expect(greetRow.source).toBe('custom');

    // Execution: the same daemon runs the tool through gateway tools/call.
    const run = await runCli(
      [
        'run',
        'personal',
        'greet',
        '--json',
        JSON.stringify({ who: 'world' }),
        '--output',
        'json',
        '--config',
        handle.target,
      ],
      { timeoutMs: 30_000 },
    );
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as {
      ok: boolean;
      result: { content: { type: string; text: string }[] };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.content).toEqual([{ type: 'text', text: 'Hello world' }]);
  }, 60_000);

  it('treats a running daemon as stale after a custom tool is disabled', async () => {
    const config = await makeConfig({ servers: {} });
    const handle = await makeTempConfig(config);
    tempConfigs.push(handle);

    expect(
      (await runCli(['tool', 'import', GREET_FIXTURE, '--yes', '--config', handle.target])).code,
    ).toBe(0);
    expect(
      (await runCli(['tool', 'enable', 'personal__greet', '--config', handle.target])).code,
    ).toBe(0);

    // Start the daemon and confirm the tool is exposed.
    await waitForToolListed(handle.target, 'personal__greet');

    // Disable the tool — this edits tools/manifest.json, not config.json.
    expect(
      (await runCli(['tool', 'disable', 'personal__greet', '--config', handle.target])).code,
    ).toBe(0);

    // The daemon identity now folds in the manifest, so the running daemon is
    // detected as stale rather than continuing to serve the disabled tool.
    const reused = await runCli(['run', '--list', '--output', 'json', '--config', handle.target], {
      timeoutMs: 30_000,
    });
    expect(reused.code).not.toBe(0);
    expect(reused.stderr).toMatch(/different config|tlbx stop/i);
  }, 60_000);
});
