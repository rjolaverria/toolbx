import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { importTool, readToolManifest, writeToolManifest } from '@toolbox/custom-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runToolInspect } from '../tool-inspect.js';
import { makeHarness, makeTempConfig, type ConfigHarness } from './harness.js';

const TOOL_SOURCE = `/**
 * @toolbox-tool name my_tool
 * @toolbox-tool title My Tool
 * @toolbox-tool description Does a thing.
 * @toolbox-tool namespace personal
 */
export const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
export default async function f() {
  return { content: [{ type: 'text', text: 'hello from the tool body' }] };
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

describe('runToolInspect', () => {
  it('prints the manifest and a head of the source', async () => {
    const exposedName = await seedTool();
    const { deps, stdout } = makeHarness(harness.target);
    const code = await runToolInspect(exposedName, {}, deps);
    expect(code).toBe(0);
    expect(stdout.value).toContain('manifest:');
    expect(stdout.value).toContain('"exposedName": "personal__my_tool"');
    expect(stdout.value).toContain('source (');
    expect(stdout.value).toContain('hello from the tool body');
  });

  it('only shows declared permission env names, never env values', async () => {
    const exposedName = await seedTool();
    // Simulate a manifest that declares an env permission (the importer defaults
    // to none today). The value of SECRET_TOKEN must never appear in output.
    const entries = await readToolManifest(harness.dir);
    const updated = entries.map((entry) =>
      entry.exposedName === exposedName
        ? { ...entry, permissions: { ...entry.permissions, env: ['SECRET_TOKEN'] } }
        : entry,
    );
    await writeToolManifest(harness.dir, updated);
    process.env.SECRET_TOKEN = 'super-secret-value';

    const { deps, stdout } = makeHarness(harness.target);
    try {
      const code = await runToolInspect(exposedName, {}, deps);
      expect(code).toBe(0);
      expect(stdout.value).toContain('SECRET_TOKEN');
      expect(stdout.value).not.toContain('super-secret-value');
    } finally {
      delete process.env.SECRET_TOKEN;
    }
  });

  it('emits JSON with manifest and source preview', async () => {
    const exposedName = await seedTool();
    const { deps, stdout } = makeHarness(harness.target);
    const code = await runToolInspect(exposedName, { json: true }, deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.value) as {
      manifest: { exposedName: string };
      source: { lines: string[] | null };
    };
    expect(parsed.manifest.exposedName).toBe('personal__my_tool');
    expect(Array.isArray(parsed.source.lines)).toBe(true);
  });

  it('reports a dangling source file without failing the manifest read', async () => {
    const exposedName = await seedTool();
    await fs.rm(path.join(harness.dir, 'tools', 'personal', 'my_tool.ts'));
    const { deps, stdout } = makeHarness(harness.target);
    const code = await runToolInspect(exposedName, {}, deps);
    expect(code).toBe(0);
    expect(stdout.value).toContain('could not read source');
  });

  it('errors on an unknown tool name', async () => {
    const { deps, stderr } = makeHarness(harness.target);
    const code = await runToolInspect('nope__missing', {}, deps);
    expect(code).toBe(1);
    expect(stderr.value).toContain('No custom tool named "nope__missing"');
  });

  it('reports a missing config and tells the user to init', async () => {
    const { deps, stderr } = makeHarness(path.join(harness.dir, 'missing', 'config.json'));
    const code = await runToolInspect('personal__my_tool', {}, deps);
    expect(code).toBe(1);
    expect(stderr.value).toContain('tlbx init');
  });

  it('refuses to read a tampered entry that escapes the tools directory', async () => {
    await seedTool();
    const entries = await readToolManifest(harness.dir);
    const tampered = entries.map((entry) => ({ ...entry, entry: '../../etc/passwd' }));
    await writeToolManifest(harness.dir, tampered);

    const { deps, stderr } = makeHarness(harness.target);
    const code = await runToolInspect('personal__my_tool', {}, deps);
    expect(code).toBe(1);
    expect(stderr.value).toContain('resolves outside the tools directory');
  });
});
