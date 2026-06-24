import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { importTool, setToolEnabled } from '@rjolaverria/toolbox-custom-tools';
import { afterEach, describe, expect, it } from 'vitest';

import { CUSTOM_TOOL_META_KEY } from '../custom-tools-host.js';

import {
  connectHttpClient,
  createIntegrationHarness,
  makeIntegrationConfig,
  startHarness,
  waitFor,
} from './__fixtures__/integration-helpers.js';

const harness = createIntegrationHarness();
const tempDirs: string[] = [];

afterEach(async () => {
  await harness.cleanup();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

const TOOL_SOURCE = `/**
 * @toolbox-tool name greet
 * @toolbox-tool title Greet
 * @toolbox-tool description Greets the named person.
 * @toolbox-tool namespace personal
 */
export const inputSchema = {
  type: 'object',
  properties: { who: { type: 'string' } },
  required: ['who'],
  additionalProperties: false,
};
export default function greet(input) {
  return { content: [{ type: 'text', text: 'Hello ' + input.who }] };
}
`;

/** Imports the greet tool into a fresh config dir, optionally enabling it. */
async function scaffoldCustomTool(enabled: boolean): Promise<string> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-p3-05-'));
  tempDirs.push(configDir);
  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-p3-05-src-'));
  tempDirs.push(srcDir);
  const srcPath = path.join(srcDir, 'greet.ts');
  await fs.writeFile(srcPath, TOOL_SOURCE, 'utf8');
  await importTool(srcPath, { configDir });
  if (enabled) {
    await setToolEnabled(configDir, 'personal__greet', true);
  }
  return configDir;
}

describe('custom tools end-to-end through the gateway (P3-05)', () => {
  it('exposes an enabled custom tool in tools/list and calls it via tools/call', async () => {
    const configDir = await scaffoldCustomTool(true);
    // No upstream servers: this case is purely about the custom-tool path.
    const { runtime, downstream } = await startHarness({
      config: makeIntegrationConfig({ servers: {} }),
      harness,
      configDir,
    });

    // The schema resolves off the hot path; wait for the registry to gain it.
    await waitFor(() => runtime.toolRegistry.find('personal__greet') !== undefined);

    const client = await connectHttpClient(downstream.url, 'p3-05-list', harness);
    const list = await client.listTools();
    const greet = list.tools.find((t) => t.name === 'personal__greet');
    expect(greet).toBeDefined();
    expect(greet?._meta?.[CUSTOM_TOOL_META_KEY]).toBe(true);

    const result = await client.callTool({
      name: 'personal__greet',
      arguments: { who: 'world' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Hello world' }]);
  }, 20_000);

  it('serves custom and upstream tools side by side, indistinguishably to the client', async () => {
    const configDir = await scaffoldCustomTool(true);
    const { runtime, downstream } = await startHarness({
      config: makeIntegrationConfig(),
      harness,
      configDir,
    });
    await waitFor(() => runtime.toolRegistry.find('personal__greet') !== undefined);

    const client = await connectHttpClient(downstream.url, 'p3-05-mixed', harness);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toContain('personal__greet');
    expect(names).toContain('echo__echo');

    // A custom call and an upstream call go through the identical tools/call path.
    const custom = await client.callTool({
      name: 'personal__greet',
      arguments: { who: 'there' },
    });
    expect(custom.content).toEqual([{ type: 'text', text: 'Hello there' }]);
    const upstream = await client.callTool({
      name: 'echo__echo',
      arguments: { message: 'ping' },
    });
    expect(upstream.content).toEqual([{ type: 'text', text: 'ping' }]);
  }, 20_000);

  it('omits a disabled custom tool from tools/list', async () => {
    const configDir = await scaffoldCustomTool(false);
    const { runtime, downstream } = await startHarness({
      config: makeIntegrationConfig({ servers: {} }),
      harness,
      configDir,
    });
    // Give the (no-op) custom load a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.toolRegistry.find('personal__greet')).toBeUndefined();

    const client = await connectHttpClient(downstream.url, 'p3-05-disabled', harness);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('personal__greet');
  }, 20_000);
});
