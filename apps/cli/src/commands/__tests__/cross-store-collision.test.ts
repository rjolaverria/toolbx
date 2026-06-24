import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { readToolManifest } from '@rjolaverria/toolbox-custom-tools';
import { loadConfig } from '@rjolaverria/toolbox-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAddStdio } from '../server-add.js';
import { runToolImport } from '../tool-import.js';
import { makeHarness, makeTempConfig, type ConfigHarness } from './harness.js';

// A custom tool whose namespace ("x") matches the server name added concurrently.
const TOOL_SOURCE = `/**
 * @toolbox-tool name go
 * @toolbox-tool title Go
 * @toolbox-tool description A self-contained tool.
 * @toolbox-tool namespace x
 */
export const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
export default async function f() {
  return { content: [{ type: 'text', text: 'ok' }] };
}
`;

let harness: ConfigHarness;

beforeEach(async () => {
  harness = await makeTempConfig();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('cross-store namespace-collision invariant under concurrency', () => {
  it('registers "x" in exactly one store when add and import race', async () => {
    const sourcePath = path.join(harness.dir, 'incoming.ts');
    await fs.writeFile(sourcePath, TOOL_SOURCE, 'utf8');

    const addHarness = makeHarness(harness.target);
    const importBase = makeHarness(harness.target);
    const importDeps = {
      ...importBase.deps,
      isTty: () => true,
      confirm: () => Promise.resolve(true),
    };

    const [addCode, importCode] = await Promise.all([
      runAddStdio('x', ['echo'], {}, addHarness.deps),
      runToolImport(sourcePath, { yes: true }, importDeps),
    ]);

    // Exactly one side wins; the other is rejected with a non-zero exit.
    expect([addCode, importCode].filter((c) => c === 0)).toHaveLength(1);

    const config = await loadConfig(harness.target);
    const manifest = await readToolManifest(harness.dir);
    const inServers = Object.prototype.hasOwnProperty.call(config.servers, 'x');
    const inTools = manifest.some((entry) => entry.namespace === 'x');

    // "x" is registered in exactly one store, never both.
    expect(inServers !== inTools).toBe(true);
  });
});
