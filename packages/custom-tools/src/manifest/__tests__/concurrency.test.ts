import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolManifest } from '../import.js';
import { readToolManifest, setToolEnabled } from '../store.js';

let configDir: string;

const SOURCE = 'export default () => ({}); export const inputSchema = {};';

function entry(name: string): ToolManifest {
  return {
    name,
    namespace: 'ns',
    exposedName: `ns__${name}`,
    title: name,
    description: name,
    entry: `tools/ns/${name}.js`,
    runtime: 'node',
    enabled: false,
    timeoutMs: 30_000,
    permissions: { network: false, filesystem: false, env: [] },
  };
}

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'tlbx-mf-'));
  const toolsDir = path.join(configDir, 'tools', 'ns');
  await mkdir(toolsDir, { recursive: true });
  await writeFile(path.join(toolsDir, 'a.js'), SOURCE);
  await writeFile(path.join(toolsDir, 'b.js'), SOURCE);
  await writeFile(
    path.join(configDir, 'tools', 'manifest.json'),
    `${JSON.stringify([entry('a'), entry('b')], null, 2)}\n`,
  );
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('concurrent manifest mutations', () => {
  it('does not lose an update when two tools are enabled at once', async () => {
    // Without the shared lock these two read-modify-write cycles race and one
    // `enabled: true` is dropped; withConfigLock makes both survive.
    await Promise.all([
      setToolEnabled(configDir, 'ns__a', true),
      setToolEnabled(configDir, 'ns__b', true),
    ]);
    const manifest = await readToolManifest(configDir);
    expect(manifest.find((e) => e.name === 'a')?.enabled).toBe(true);
    expect(manifest.find((e) => e.name === 'b')?.enabled).toBe(true);
  });
});
