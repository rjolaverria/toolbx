import { fileURLToPath } from 'node:url';

import { createNoopLogger, type StdioServerConfig } from '@toolbox/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  UpstreamCallToolTimeoutError,
  UpstreamConnectError,
  UpstreamMissingEnvVarError,
  UpstreamNotConnectedError,
} from '../errors.js';
import { createStdioUpstreamClient } from '../stdio.js';
import type { UpstreamClient } from '../types.js';

const ECHO_SERVER_PATH = fileURLToPath(new URL('./__fixtures__/echo-server.mjs', import.meta.url));
const LONG_RUNNING_PATH = fileURLToPath(
  new URL('./__fixtures__/long-running.mjs', import.meta.url),
);

function echoConfig(overrides: Partial<StdioServerConfig> = {}): StdioServerConfig {
  return {
    type: 'stdio',
    enabled: true,
    command: process.execPath,
    args: [ECHO_SERVER_PATH],
    ...overrides,
  };
}

const activeClients = new Set<UpstreamClient>();

function track(client: UpstreamClient): UpstreamClient {
  activeClients.add(client);
  return client;
}

afterEach(async () => {
  for (const client of activeClients) {
    await client.disconnect().catch(() => undefined);
  }
  activeClients.clear();
});

describe('createStdioUpstreamClient — connect', () => {
  it('connects, lists tools, and calls a tool against a real stdio MCP server', async () => {
    const client = track(createStdioUpstreamClient(echoConfig(), { logger: createNoopLogger() }));

    await client.connect();

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['echo', 'emit_log', 'slow']);

    const result = await client.callTool('echo', { message: 'hi from toolbox' });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'hi from toolbox' }],
    });
  });

  it('rejects with UpstreamConnectError when the command does not exist', async () => {
    const client = track(
      createStdioUpstreamClient(
        echoConfig({ command: '/definitely/not/a/real/command/toolbox-test' }),
        { logger: createNoopLogger() },
      ),
    );

    await expect(client.connect()).rejects.toBeInstanceOf(UpstreamConnectError);
  });

  it('rejects with UpstreamConnectError when the child exits before initialize completes', async () => {
    // `node -e "process.exit(1)"` spawns successfully but exits immediately.
    const client = track(
      createStdioUpstreamClient(
        echoConfig({ command: process.execPath, args: ['-e', 'process.exit(1)'] }),
        { logger: createNoopLogger() },
      ),
    );

    await expect(client.connect()).rejects.toBeInstanceOf(UpstreamConnectError);
  });

  it('throws UpstreamMissingEnvVarError when a required ${env:VAR} placeholder is unset', async () => {
    const client = track(
      createStdioUpstreamClient(echoConfig({ env: { TOKEN: '${env:TOOLBOX_TEST_MISSING_VAR}' } }), {
        logger: createNoopLogger(),
        processEnv: {},
        serverName: 'fake',
      }),
    );

    await expect(client.connect()).rejects.toBeInstanceOf(UpstreamMissingEnvVarError);
  });
});

describe('createStdioUpstreamClient — disconnect', () => {
  it('terminates a long-running child without leaving an orphan', async () => {
    const client = track(
      createStdioUpstreamClient(
        {
          type: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [LONG_RUNNING_PATH],
        },
        { logger: createNoopLogger(), connectTimeoutMs: 250 },
      ),
    );

    // The long-running fixture never speaks MCP, so connect() will fail at
    // initialize. We use it solely to verify that the child process is reaped.
    const exitInfo: Array<{ intentional: boolean }> = [];
    client.on('exit', (info) => {
      exitInfo.push(info);
    });

    await expect(client.connect()).rejects.toBeDefined();
    // The child should have been killed during the failed connect's cleanup.
    expect(exitInfo).toHaveLength(1);
  }, 15_000);

  it('is idempotent — calling disconnect() twice is safe', async () => {
    const client = track(createStdioUpstreamClient(echoConfig(), { logger: createNoopLogger() }));

    await client.connect();
    await client.disconnect();
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it('disconnect on an idle client is a no-op', async () => {
    const client = track(createStdioUpstreamClient(echoConfig(), { logger: createNoopLogger() }));
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it('throws UpstreamNotConnectedError when callTool is invoked after disconnect', async () => {
    const client = track(createStdioUpstreamClient(echoConfig(), { logger: createNoopLogger() }));
    await client.connect();
    await client.disconnect();

    await expect(client.callTool('echo', { message: 'after-close' })).rejects.toBeInstanceOf(
      UpstreamNotConnectedError,
    );
  });

  it('does not race when disconnect() runs while connect() is in flight', async () => {
    const client = track(createStdioUpstreamClient(echoConfig(), { logger: createNoopLogger() }));

    // Start connecting, then immediately disconnect without awaiting connect.
    // Either the connect rejects (because we tore it down mid-flight) or it
    // resolves and the subsequent state is already closed — but in no case
    // should we end up with a live but un-tracked process.
    const connectPromise = client.connect();
    const disconnectPromise = client.disconnect();

    await disconnectPromise;
    await connectPromise.catch(() => undefined);

    // After the dust settles, the client is closed and operations fail with
    // UpstreamNotConnectedError rather than crashing on a half-initialized
    // transport.
    await expect(client.callTool('echo', { message: 'noop' })).rejects.toBeInstanceOf(
      UpstreamNotConnectedError,
    );
  });
});

describe('createStdioUpstreamClient — callTool timeout', () => {
  it('rejects with UpstreamCallToolTimeoutError that names the offending tool', async () => {
    const client = track(createStdioUpstreamClient(echoConfig(), { logger: createNoopLogger() }));
    await client.connect();

    let caught: unknown;
    try {
      await client.callTool('slow', { delayMs: 5_000 }, { timeoutMs: 50 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UpstreamCallToolTimeoutError);
    if (caught instanceof UpstreamCallToolTimeoutError) {
      expect(caught.toolName).toBe('slow');
      expect(caught.timeoutMs).toBe(50);
    }
  });
});

describe('createStdioUpstreamClient — stderr forwarding', () => {
  it('forwards stderr lines to the log event at debug level', async () => {
    const client = track(
      createStdioUpstreamClient(
        echoConfig({ env: { TOOLBOX_FIXTURE_STARTUP_STDERR: 'ready: hello' } }),
        { logger: createNoopLogger() },
      ),
    );

    const logLines: string[] = [];
    client.on('log', (entry) => {
      logLines.push(entry.message);
    });

    await client.connect();
    // The fixture also exposes a tool that writes to stderr on demand. Use it
    // to deterministically observe a forwarded stderr line.
    await client.callTool('emit_log', { message: 'from-the-tool' });

    // Wait briefly for the readline 'line' event to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(logLines).toContain('ready: hello');
    expect(logLines).toContain('from-the-tool');
  });
});

describe('createStdioUpstreamClient — ping', () => {
  it('round-trips a ping against the upstream server', async () => {
    const client = track(createStdioUpstreamClient(echoConfig(), { logger: createNoopLogger() }));
    await client.connect();
    await expect(client.ping()).resolves.toBeUndefined();
  });
});
