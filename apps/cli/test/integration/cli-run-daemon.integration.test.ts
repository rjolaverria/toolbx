// Daemon-backed integration tests for `tlbx run` (P2-06, SPECS §5.3, §5.6).
//
// Unlike the other integration suites, these drive the *built binary* through
// real subprocesses: `tlbx run` auto-starts a detached daemon, reuses it,
// converges concurrent cold starts onto one daemon, refuses a same-port
// foreign daemon, and tears down with `tlbx stop`. The upstream fixtures are
// the same stdio / HTTP echo servers the unit and Phase 1 suites use, so the
// surface under test is identical end to end.
//
// Isolation: every test gets its own temp config dir. The daemon state and log
// paths are keyed off the resolved config path (see `serveDaemonPathsForConfig`),
// so distinct configs never share daemon state, and the configured downstream
// HTTP port is ephemeral per config. `afterEach` stops every daemon (and
// force-kills as a fallback) before removing the temp dirs, so a failed
// assertion can never leak a detached daemon out of the suite.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { isProcessAlive, type ToolBoxConfig } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HTTP_ECHO_FIXTURE_MODULE,
  STDIO_ECHO_FIXTURE,
  daemonPid,
  makeConfig,
  makeTempConfig,
  readDaemonState,
  runCli,
  stopDaemon,
  type TempConfigHandle,
} from './helpers.js';

// `.mjs` fixtures ship no .d.ts; describe the shape we use rather than `any`.
interface HttpEchoServer {
  url: string;
  close: () => Promise<void>;
}
interface HttpEchoModule {
  startHttpEchoServer: (options?: { requireBearerToken?: string }) => Promise<HttpEchoServer>;
}

const tempConfigs: TempConfigHandle[] = [];
const activeUpstreams = new Set<HttpEchoServer>();

afterEach(async () => {
  // Stop daemons before removing temp dirs: stop reads the state file that
  // lives inside the dir, and we want the real `tlbx stop` path exercised even
  // on the happy-path tests.
  for (const handle of tempConfigs) {
    await stopDaemon(handle.target);
  }
  for (const upstream of activeUpstreams) {
    await upstream.close().catch(() => undefined);
  }
  activeUpstreams.clear();
  while (tempConfigs.length > 0) {
    const handle = tempConfigs.pop();
    await handle?.cleanup();
  }
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cold-starts (or reuses) the daemon for a config by polling `tlbx run --list`
 * until `exposedName` shows up. The daemon publishes readiness once its HTTP
 * listener binds — before any upstream session connects — so a bare tool call
 * can race ahead of the upstream. Polling the control-plane listing (which is
 * not subject to per-server `timeoutMs`) is the deterministic way to wait for
 * the upstream to land, mirroring how a real MCP client reacts to a
 * `tools/list_changed`. Returns once the tool is present.
 */
async function waitForToolListed(
  configPath: string,
  exposedName: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const res = await runCli(['run', '--list', '--output', 'json', '--config', configPath]);
    last = `code=${String(res.code)} stdout=${res.stdout} stderr=${res.stderr}`;
    if (res.code === 0) {
      const rows = JSON.parse(res.stdout) as Array<{ exposedName: string }>;
      if (rows.some((row) => row.exposedName === exposedName)) {
        return;
      }
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for "${exposedName}" to be listed; last: ${last}`);
}

/** A config wired to the stdio echo fixture, disclosure off, on an ephemeral port. */
function stdioEchoConfig(): Promise<ToolBoxConfig> {
  return makeConfig({
    progressiveDisclosure: { enabled: false, bootstrapTools: false },
    servers: {
      echo: {
        type: 'stdio',
        enabled: true,
        command: process.execPath,
        args: [STDIO_ECHO_FIXTURE],
      },
    },
  });
}

async function startHttpEchoUpstream(): Promise<HttpEchoServer> {
  const mod = (await import(HTTP_ECHO_FIXTURE_MODULE)) as HttpEchoModule;
  const server = await mod.startHttpEchoServer();
  activeUpstreams.add(server);
  return server;
}

describe('tlbx run — stdio daemon lifecycle', () => {
  it('auto-starts the daemon, runs a tool, and reuses the same daemon on a second call', async () => {
    const handle = await makeTempConfig(await stdioEchoConfig());
    tempConfigs.push(handle);

    // No daemon yet — the first invocation must cold-start one.
    expect(await daemonPid(handle.target)).toBeNull();

    await waitForToolListed(handle.target, 'echo__echo');

    const pidAfterStart = await daemonPid(handle.target);
    expect(pidAfterStart).not.toBeNull();
    expect(isProcessAlive(pidAfterStart as number)).toBe(true);

    // First real call succeeds.
    const first = await runCli([
      'run',
      'echo',
      'echo',
      '--json',
      JSON.stringify({ message: 'hello via run' }),
      '--output',
      'json',
      '--config',
      handle.target,
    ]);
    expect(first.code).toBe(0);
    const firstEnvelope = JSON.parse(first.stdout) as {
      ok: boolean;
      exposedName: string;
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(firstEnvelope.ok).toBe(true);
    expect(firstEnvelope.exposedName).toBe('echo__echo');
    expect(firstEnvelope.result.content).toEqual([{ type: 'text', text: 'hello via run' }]);

    // Second call reuses the same daemon — proven by an unchanged pid.
    const second = await runCli([
      'run',
      'echo',
      'echo',
      '--json',
      JSON.stringify({ message: 'second call' }),
      '--output',
      'json',
      '--config',
      handle.target,
    ]);
    expect(second.code).toBe(0);
    const secondEnvelope = JSON.parse(second.stdout) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(secondEnvelope.result.content).toEqual([{ type: 'text', text: 'second call' }]);

    expect(await daemonPid(handle.target)).toBe(pidAfterStart);
  });

  it('converges two concurrent cold-start calls onto a single daemon', async () => {
    const handle = await makeTempConfig(await stdioEchoConfig());
    tempConfigs.push(handle);

    expect(await daemonPid(handle.target)).toBeNull();

    // Two cold starts at once. `--list` succeeds regardless of whether the
    // upstream has connected yet, so this isolates daemon convergence from the
    // upstream readiness race: exactly one of the two spawned daemons wins the
    // port bind, the other reuses it, and neither errors or orphans.
    const [a, b] = await Promise.all([
      runCli(['run', '--list', '--output', 'json', '--config', handle.target]),
      runCli(['run', '--list', '--output', 'json', '--config', handle.target]),
    ]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);

    const state = await readDaemonState(handle.target);
    expect(state).not.toBeNull();
    expect(isProcessAlive((state as { pid: number }).pid)).toBe(true);
  });

  it('runs when server.http.enabled is false (the daemon forces loopback HTTP)', async () => {
    const base = await stdioEchoConfig();
    const config: ToolBoxConfig = {
      ...base,
      server: { ...base.server, http: { ...base.server.http, enabled: false } },
    };
    const handle = await makeTempConfig(config);
    tempConfigs.push(handle);

    await waitForToolListed(handle.target, 'echo__echo');

    const result = await runCli([
      'run',
      'echo',
      'echo',
      '--json',
      JSON.stringify({ message: 'http disabled' }),
      '--output',
      'json',
      '--config',
      handle.target,
    ]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(envelope.result.content).toEqual([{ type: 'text', text: 'http disabled' }]);
  });

  it('tlbx stop stops a daemon that tlbx run started', async () => {
    const handle = await makeTempConfig(await stdioEchoConfig());
    tempConfigs.push(handle);

    await waitForToolListed(handle.target, 'echo__echo');
    const pid = await daemonPid(handle.target);
    expect(pid).not.toBeNull();
    expect(isProcessAlive(pid as number)).toBe(true);

    const stopped = await runCli(['stop', '--config', handle.target]);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain('stopped');

    // State cleared and the process is gone.
    expect(await readDaemonState(handle.target)).toBeNull();
    // Give the OS a beat to reap the just-signalled process before asserting.
    const deadline = Date.now() + 2_000;
    while (isProcessAlive(pid as number) && Date.now() < deadline) {
      await delay(50);
    }
    expect(isProcessAlive(pid as number)).toBe(false);
  });

  it('starts a separate daemon per config on a different endpoint', async () => {
    const configA = await stdioEchoConfig();
    // `getEphemeralPort` releases its socket immediately, so two independent
    // configs can land on the same port — which would route this onto the
    // same-port collision path instead. Resample until the ports differ so the
    // test deterministically exercises two distinct endpoints.
    let configC = await stdioEchoConfig();
    while (configC.server.http.port === configA.server.http.port) {
      configC = await stdioEchoConfig();
    }
    const handleA = await makeTempConfig(configA);
    const handleC = await makeTempConfig(configC);
    tempConfigs.push(handleA, handleC);

    // Different config paths on different ephemeral ports → two daemons.
    const [a, c] = await Promise.all([
      runCli(['run', '--list', '--output', 'json', '--config', handleA.target]),
      runCli(['run', '--list', '--output', 'json', '--config', handleC.target]),
    ]);
    expect(a.code).toBe(0);
    expect(c.code).toBe(0);

    const pidA = await daemonPid(handleA.target);
    const pidC = await daemonPid(handleC.target);
    expect(pidA).not.toBeNull();
    expect(pidC).not.toBeNull();
    expect(pidA).not.toBe(pidC);
    expect(isProcessAlive(pidA as number)).toBe(true);
    expect(isProcessAlive(pidC as number)).toBe(true);
  });

  it('rejects a same-port daemon started from a different config', async () => {
    // Config A and config B share a downstream port but differ in content
    // (B registers a second server), so they hash differently and are distinct
    // daemons. Once A holds the port, B's cold start cannot bind it and must
    // report a clear collision rather than reuse A's foreign daemon.
    const configA = await stdioEchoConfig();
    const configB: ToolBoxConfig = {
      ...configA,
      server: { ...configA.server, http: { ...configA.server.http } },
      servers: {
        ...configA.servers,
        echo2: {
          type: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [STDIO_ECHO_FIXTURE],
        },
      },
    };

    const handleA = await makeTempConfig(configA);
    const handleB = await makeTempConfig(configB);
    tempConfigs.push(handleA, handleB);

    const a = await runCli(['run', '--list', '--output', 'json', '--config', handleA.target]);
    expect(a.code).toBe(0);
    expect(await daemonPid(handleA.target)).not.toBeNull();

    const b = await runCli(['run', '--list', '--output', 'json', '--config', handleB.target]);
    // Daemon startup failure → exit 3 (EXIT_DAEMON), with a collision message.
    expect(b.code).toBe(3);
    expect(b.stderr).toContain('cannot bind');
    expect(b.stderr).toContain('different config');
    // B never published its own daemon record.
    expect(await readDaemonState(handleB.target)).toBeNull();
  });

  it('honors the input modes (exposed-name, --stdin, --file) and output modes (text, mcp)', async () => {
    const handle = await makeTempConfig(await stdioEchoConfig());
    tempConfigs.push(handle);

    await waitForToolListed(handle.target, 'echo__echo');

    // Single positional = a fully exposed name (`echo__echo`), --output text:
    // text mode prints just the joined text content, no JSON envelope.
    const exposedNameText = await runCli([
      'run',
      'echo__echo',
      '--json',
      JSON.stringify({ message: 'exposed name' }),
      '--output',
      'text',
      '--config',
      handle.target,
    ]);
    expect(exposedNameText.code).toBe(0);
    expect(exposedNameText.stdout.trim()).toBe('exposed name');

    // --stdin: arguments read as JSON from stdin.
    const viaStdin = await runCli(
      ['run', 'echo', 'echo', '--stdin', '--output', 'text', '--config', handle.target],
      { stdin: JSON.stringify({ message: 'via stdin' }) },
    );
    expect(viaStdin.code).toBe(0);
    expect(viaStdin.stdout.trim()).toBe('via stdin');

    // --file: arguments read as JSON from a file.
    const argFile = path.join(handle.dir, 'args.json');
    await fs.writeFile(argFile, JSON.stringify({ message: 'via file' }), 'utf8');
    const viaFile = await runCli([
      'run',
      'echo',
      'echo',
      '--file',
      argFile,
      '--output',
      'text',
      '--config',
      handle.target,
    ]);
    expect(viaFile.code).toBe(0);
    expect(viaFile.stdout.trim()).toBe('via file');

    // --output mcp: the raw CallToolResult, not the agent envelope.
    const mcp = await runCli([
      'run',
      'echo',
      'echo',
      '--json',
      JSON.stringify({ message: 'raw mcp' }),
      '--output',
      'mcp',
      '--config',
      handle.target,
    ]);
    expect(mcp.code).toBe(0);
    const raw = JSON.parse(mcp.stdout) as {
      content: Array<{ type: string; text: string }>;
      ok?: unknown;
    };
    expect(raw.content).toEqual([{ type: 'text', text: 'raw mcp' }]);
    // `mcp` mode emits the upstream result verbatim — never the `ok` envelope.
    expect(raw.ok).toBeUndefined();
  });

  it('reports a disabled tool with exit 4 and a re-enable hint', async () => {
    const base = await stdioEchoConfig();
    // Disable a single namespaced tool. The gateway hides it and refuses a call
    // as MethodNotFound; `tlbx run` consults the config to name the exact
    // re-enable command (SPECS §5.5).
    const config: ToolBoxConfig = { ...base, tools: { echo__echo: { enabled: false } } };
    const handle = await makeTempConfig(config);
    tempConfigs.push(handle);

    // The disabled tool is absent from the listing, but `echo__slow` confirms
    // the upstream connected before we probe the disabled one.
    await waitForToolListed(handle.target, 'echo__slow');

    const result = await runCli([
      'run',
      'echo',
      'echo',
      '--json',
      JSON.stringify({ message: 'nope' }),
      '--output',
      'text',
      '--config',
      handle.target,
    ]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('disabled');
    expect(result.stderr).toContain('tlbx tools enable echo__echo');
  });
});

describe('tlbx run — HTTP upstream', () => {
  it('runs a tool against an HTTP upstream through the daemon', async () => {
    const upstream = await startHttpEchoUpstream();
    const config = await makeConfig({
      progressiveDisclosure: { enabled: false, bootstrapTools: false },
      servers: {
        remote: { type: 'http', enabled: true, url: upstream.url, auth: { type: 'none' } },
      },
    });
    const handle = await makeTempConfig(config);
    tempConfigs.push(handle);

    await waitForToolListed(handle.target, 'remote__echo');

    const result = await runCli([
      'run',
      'remote',
      'echo',
      '--json',
      JSON.stringify({ message: 'hello over http' }),
      '--output',
      'json',
      '--config',
      handle.target,
    ]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(envelope.result.content).toEqual([{ type: 'text', text: 'hello over http' }]);
  });

  it('surfaces an upstream call timeout as exit 6', async () => {
    const upstream = await startHttpEchoUpstream();
    const config = await makeConfig({
      progressiveDisclosure: { enabled: false, bootstrapTools: false },
      servers: {
        // A tight per-server timeout: the `slow` tool sleeps far longer, so the
        // proxied call is aborted and reported as a timeout (exit 6). `tools/list`
        // is not subject to this timeout, so discovery still works.
        remote: {
          type: 'http',
          enabled: true,
          url: upstream.url,
          auth: { type: 'none' },
          timeoutMs: 50,
        },
      },
    });
    const handle = await makeTempConfig(config);
    tempConfigs.push(handle);

    await waitForToolListed(handle.target, 'remote__slow');

    const result = await runCli([
      'run',
      'remote',
      'slow',
      '--json',
      JSON.stringify({ delayMs: 3_000 }),
      '--output',
      'json',
      '--config',
      handle.target,
    ]);
    expect(result.code).toBe(6);
    expect(result.stderr).toContain('timed out');
    const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { kind: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.kind).toBe('timeout');
  });
});

describe('tlbx run — discovery against the daemon', () => {
  it('serves --list, --search, --describe, --schema, and --example from a reused daemon', async () => {
    const handle = await makeTempConfig(await stdioEchoConfig());
    tempConfigs.push(handle);

    // Warm the daemon and wait for the upstream catalogue to land.
    await waitForToolListed(handle.target, 'echo__echo');
    const pid = await daemonPid(handle.target);
    expect(pid).not.toBeNull();

    // --list (json): the full enabled catalogue.
    const list = await runCli(['run', '--list', '--output', 'json', '--config', handle.target]);
    expect(list.code).toBe(0);
    const listed = JSON.parse(list.stdout) as Array<{ exposedName: string }>;
    expect(listed.map((row) => row.exposedName).sort()).toEqual([
      'echo__echo',
      'echo__emit_log',
      'echo__slow',
    ]);

    // --search: ranked matches for a query.
    const search = await runCli([
      'run',
      '--search',
      'echo',
      '--output',
      'json',
      '--config',
      handle.target,
    ]);
    expect(search.code).toBe(0);
    const hits = JSON.parse(search.stdout) as Array<{ exposedName: string }>;
    expect(hits.some((hit) => hit.exposedName === 'echo__echo')).toBe(true);

    // --describe: fields + an example invocation.
    const describe_ = await runCli([
      'run',
      'echo',
      'echo',
      '--describe',
      '--output',
      'json',
      '--config',
      handle.target,
    ]);
    expect(describe_.code).toBe(0);
    const described = JSON.parse(describe_.stdout) as {
      exposedName: string;
      required: Array<{ name: string }>;
    };
    expect(described.exposedName).toBe('echo__echo');
    expect(described.required.map((field) => field.name)).toContain('message');

    // --schema: the raw input schema.
    const schema = await runCli(['run', 'echo', 'echo', '--schema', '--config', handle.target]);
    expect(schema.code).toBe(0);
    const parsedSchema = JSON.parse(schema.stdout) as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(parsedSchema.type).toBe('object');
    expect(parsedSchema.properties).toHaveProperty('message');

    // --example: a JSON argument skeleton.
    const example = await runCli(['run', 'echo', 'echo', '--example', '--config', handle.target]);
    expect(example.code).toBe(0);
    const skeleton = JSON.parse(example.stdout) as Record<string, unknown>;
    expect(skeleton).toHaveProperty('message');

    // Every discovery form reused the one daemon.
    expect(await daemonPid(handle.target)).toBe(pid);
  });
});
