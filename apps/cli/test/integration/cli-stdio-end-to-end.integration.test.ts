// End-to-end CLI integration test: drives the real `tlbx` binary through
// the real Phase 1 setup flow (init → server add-stdio → serve --stdio) and
// connects to it as an MCP client. This covers SPECS §4.8 acceptance
// criteria 1, 2, 4, 5, 6, 7, 11 — the same path a Claude / Codex / OpenCode
// user would hit in production.
//
// The fixture upstream is `echo-server.mjs` from M1-01, reused unchanged so
// the integration suite exercises identical wiring to the unit tests.

import * as fs from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_CONFIG, loadConfig } from '@toolbx/core';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultServerAddDeps, runAddStdio } from '../../src/commands/server-add.js';
import { runInit, type InitDeps } from '../../src/commands/init.js';
import { runStatus, type StatusDeps } from '../../src/commands/status.js';
import type { ProbeResult } from '../../src/commands/server-probe.js';

import { CLI_BIN, STDIO_ECHO_FIXTURE, makeTempConfig, type TempConfigHandle } from './helpers.js';

const tempConfigs: TempConfigHandle[] = [];
const activeClients = new Set<Client>();

afterEach(async () => {
  for (const client of activeClients) {
    await client.close().catch(() => undefined);
  }
  activeClients.clear();
  while (tempConfigs.length > 0) {
    const handle = tempConfigs.pop();
    await handle?.cleanup();
  }
});

function captureIo(): {
  stdout: { value: string };
  stderr: { value: string };
  initDeps: (target: string) => InitDeps;
  statusDeps: (target: string) => StatusDeps;
} {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const initDeps = (target: string): InitDeps => ({
    resolvePath: () => target,
    cwd: () => process.cwd(),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
  });
  const statusDeps = (target: string): StatusDeps => ({
    resolvePath: () => target,
    cwd: () => process.cwd(),
    stdout: (msg) => {
      stdout.value += msg;
    },
    stderr: (msg) => {
      stderr.value += msg;
    },
    // The test runs status with --no-connect, so the probe is never invoked;
    // wire a deterministic stub anyway so a regression that changes the flag
    // surface fails loudly instead of taking a real probe path.
    probe: () =>
      Promise.resolve({
        kind: 'connected',
        tools: [],
        connectedAt: new Date(),
      } satisfies ProbeResult),
  });
  return { stdout, stderr, initDeps, statusDeps };
}

describe('end-to-end CLI lifecycle (stdio downstream)', () => {
  it('init → server add-stdio → serve --stdio → MCP client roundtrip', async () => {
    // 1. `tlbx init` writes the default config (acceptance criterion #1).
    const handle = await makeTempConfig(DEFAULT_CONFIG);
    tempConfigs.push(handle);
    // We seed with DEFAULT_CONFIG above, but exercise the real init code path
    // here too: it's idempotent with --force and that's the easiest way to
    // re-verify the file ends up valid against the schema.
    const io = captureIo();
    const initCode = await runInit(
      { force: true, path: handle.target },
      io.initDeps(handle.target),
    );
    expect(initCode).toBe(0);
    const initialConfig = await loadConfig(handle.target);
    expect(initialConfig).toEqual(DEFAULT_CONFIG);

    // 2. `tlbx server add-stdio echo -- node <fixture>` (acceptance criterion #2).
    const addCode = await runAddStdio(
      'echo',
      [process.execPath, STDIO_ECHO_FIXTURE],
      { config: handle.target },
      defaultServerAddDeps(),
    );
    expect(addCode).toBe(0);
    const afterAdd = await loadConfig(handle.target);
    const echo = afterAdd.servers['echo'];
    expect(echo).toMatchObject({
      type: 'stdio',
      enabled: true,
      command: process.execPath,
      args: [STDIO_ECHO_FIXTURE],
    });

    // Disable progressive disclosure (and the bootstrap surface that comes
    // with it) for this test so `tools/list` returns the full namespaced
    // upstream catalogue directly. The disclosure / bootstrap paths have
    // their own dedicated integration test.
    const flippedConfig = {
      ...afterAdd,
      progressiveDisclosure: {
        ...afterAdd.progressiveDisclosure,
        enabled: false,
        bootstrapTools: false,
      },
    };
    await fs.writeFile(handle.target, `${JSON.stringify(flippedConfig, null, 2)}\n`, 'utf8');

    // 3. Spawn the actual CLI binary in stdio mode and connect via the MCP
    //    SDK's StdioClientTransport — the same transport Claude Desktop and
    //    Codex use. Covers acceptance criteria #4 and #5.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_BIN, 'serve', '--stdio', '--config', handle.target, '--log-level', 'error'],
      // Inherit `process.env` so `node` can find its installed pnpm-managed
      // modules from the workspace.
      env: { ...process.env } as Record<string, string>,
      // Suppress fixture log noise — the upstream echo-server writes a few
      // lines to stderr on startup.
      stderr: 'ignore',
    });
    const client = new Client(
      { name: 'toolbx-cli-stdio-it', version: '0.0.0' },
      { capabilities: {} },
    );
    activeClients.add(client);
    await client.connect(transport);

    // 4. Initialize succeeded; identify the server (`toolbx`) and confirm
    //    the namespaced tools are exposed (acceptance criteria #6, #7).
    expect(client.getServerVersion()?.name).toBe('toolbx');

    // The upstream session connects asynchronously after the downstream
    // binds; the gateway accepts requests immediately and yields an empty
    // catalogue until the first upstream attempt resolves. Poll tools/list
    // until the namespaced echo tools land — this mirrors how a real client
    // would react to a `notifications/tools/list_changed` and re-list.
    let exposed: string[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const list = await client.listTools();
      exposed = list.tools.map((t) => t.name).sort();
      if (exposed.includes('echo__echo')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The fixture exposes echo / emit_log / slow; Toolbx namespaces them.
    expect(exposed).toEqual(['echo__echo', 'echo__emit_log', 'echo__slow']);

    const result = await client.callTool({
      name: 'echo__echo',
      arguments: { message: 'hello via tlbx' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'hello via tlbx' }]);

    await client.close();
    activeClients.delete(client);

    // 5. `tlbx status` reports the upstream (acceptance criterion #11).
    //    The serve process has exited by now (client.close drops the stdin
    //    EOF), but status reads the on-disk config, not a running gateway.
    const statusIo = captureIo();
    const statusCode = await runStatus(
      { config: handle.target, json: true, connect: false },
      statusIo.statusDeps(handle.target),
    );
    expect(statusCode).toBe(0);
    const report = JSON.parse(statusIo.stdout.value) as Array<{
      name: string;
      enabled: boolean;
      type: string;
      status: string;
    }>;
    expect(report).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'echo',
          enabled: true,
          type: 'stdio',
          status: 'enabled',
        }),
      ]),
    );
  }, 30_000);
});
