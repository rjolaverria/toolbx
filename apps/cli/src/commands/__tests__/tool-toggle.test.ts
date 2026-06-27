import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { importTool, readToolManifest } from '@toolbx/custom-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runToolDisable, runToolEnable } from '../tool-toggle.js';
import { makeHarness, makeTempConfig, type ConfigHarness } from './harness.js';

const TOOL_SOURCE = `/**
 * @toolbx-tool name my_tool
 * @toolbx-tool title My Tool
 * @toolbx-tool description Does a thing.
 * @toolbx-tool namespace personal
 */
export const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
export default async function f() {
  return { content: [] };
}
`;

let harness: ConfigHarness;

beforeEach(async () => {
  harness = await makeTempConfig();
});

afterEach(async () => {
  await harness.cleanup();
});

async function seedTool(): Promise<string> {
  const sourcePath = path.join(harness.dir, 'my_tool.ts');
  await fs.writeFile(sourcePath, TOOL_SOURCE, 'utf8');
  const result = await importTool(sourcePath, { configDir: harness.dir });
  await fs.rm(sourcePath);
  return result.manifest.exposedName;
}

describe('runToolEnable / runToolDisable', () => {
  it('enables a disabled tool and persists the change', async () => {
    const exposedName = await seedTool();
    const { deps, stdout } = makeHarness(harness.target);
    const code = await runToolEnable(exposedName, {}, deps);
    expect(code).toBe(0);
    expect(stdout.value).toContain('enabled');
    const entries = await readToolManifest(harness.dir);
    expect(entries[0]?.enabled).toBe(true);
  });

  it('is a no-op when the tool is already in the requested state', async () => {
    const exposedName = await seedTool();
    const { deps, stdout } = makeHarness(harness.target);
    const code = await runToolDisable(exposedName, {}, deps);
    expect(code).toBe(0);
    expect(stdout.value).toContain('already disabled');
  });

  it('disables a previously enabled tool', async () => {
    const exposedName = await seedTool();
    const { deps } = makeHarness(harness.target);
    await runToolEnable(exposedName, {}, deps);
    const code = await runToolDisable(exposedName, {}, deps);
    expect(code).toBe(0);
    const entries = await readToolManifest(harness.dir);
    expect(entries[0]?.enabled).toBe(false);
  });

  it('errors on an unknown tool name', async () => {
    const { deps, stderr } = makeHarness(harness.target);
    const code = await runToolEnable('nope__missing', {}, deps);
    expect(code).toBe(1);
    expect(stderr.value).toContain('no custom tool named "nope__missing"');
  });

  it('reports a missing config and tells the user to init', async () => {
    const { deps, stderr } = makeHarness(path.join(harness.dir, 'missing', 'config.json'));
    const code = await runToolEnable('personal__my_tool', {}, deps);
    expect(code).toBe(1);
    expect(stderr.value).toContain('tlbx init');
  });
});
