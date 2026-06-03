import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { importTool, readToolManifest } from '@toolbox/custom-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runToolRemove, type ToolRemoveDeps } from '../tool-remove.js';
import { makeHarness, makeTempConfig, type ConfigHarness } from './harness.js';

const TOOL_SOURCE = `/**
 * @toolbox-tool name my_tool
 * @toolbox-tool title My Tool
 * @toolbox-tool description Does a thing.
 * @toolbox-tool namespace personal
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

interface RemoveHarness {
  deps: ToolRemoveDeps;
  stdout: { value: string };
  stderr: { value: string };
  confirm: ReturnType<typeof vi.fn>;
}

function makeRemoveHarness(answer: boolean, tty = true): RemoveHarness {
  const base = makeHarness(harness.target);
  const confirm = vi.fn().mockResolvedValue(answer);
  const deps: ToolRemoveDeps = { ...base.deps, isTty: () => tty, confirm };
  return { deps, stdout: base.stdout, stderr: base.stderr, confirm };
}

describe('runToolRemove', () => {
  it('removes the source file and manifest entry after confirmation', async () => {
    const exposedName = await seedTool();
    const entryPath = path.join(harness.dir, 'tools', 'personal', 'my_tool.ts');
    const { deps, stdout, confirm } = makeRemoveHarness(true);

    const code = await runToolRemove(exposedName, {}, deps);

    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(stdout.value).toContain(`Removed custom tool "${exposedName}"`);
    await expect(fs.access(entryPath)).rejects.toThrow();
    await expect(readToolManifest(harness.dir)).resolves.toEqual([]);
  });

  it('aborts when the user declines', async () => {
    const exposedName = await seedTool();
    const { deps, stderr } = makeRemoveHarness(false);

    const code = await runToolRemove(exposedName, {}, deps);

    expect(code).toBe(1);
    expect(stderr.value).toContain('was not removed');
    await expect(readToolManifest(harness.dir)).resolves.toHaveLength(1);
  });

  it('skips confirmation with --yes', async () => {
    const exposedName = await seedTool();
    const { deps, confirm } = makeRemoveHarness(false);

    const code = await runToolRemove(exposedName, { yes: true }, deps);

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('refuses without --yes in a non-interactive shell', async () => {
    const exposedName = await seedTool();
    const { deps, stderr } = makeRemoveHarness(true, false);

    const code = await runToolRemove(exposedName, {}, deps);

    expect(code).toBe(2);
    expect(stderr.value).toContain('Re-run with --yes');
    await expect(readToolManifest(harness.dir)).resolves.toHaveLength(1);
  });

  it('errors on an unknown tool name', async () => {
    const { deps, stderr } = makeRemoveHarness(true);
    const code = await runToolRemove('nope__missing', { yes: true }, deps);
    expect(code).toBe(1);
    expect(stderr.value).toContain('No custom tool named "nope__missing"');
  });

  it('reports an unknown tool as tool-not-found before prompting, even non-interactively', async () => {
    // Non-interactive + no --yes used to hit the confirmation-refusal path (exit
    // 2); the existence check now runs first, so an unknown tool is exit 1.
    const { deps, stderr, confirm } = makeRemoveHarness(true, false);
    const code = await runToolRemove('nope__missing', {}, deps);
    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(stderr.value).toContain('No custom tool named "nope__missing"');
  });

  it('does not prompt to remove a tool that does not exist', async () => {
    const { deps, confirm } = makeRemoveHarness(true);
    const code = await runToolRemove('nope__missing', {}, deps);
    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reports a missing config and tells the user to init', async () => {
    const missingTarget = path.join(harness.dir, 'missing', 'config.json');
    const base = makeHarness(missingTarget);
    const deps: ToolRemoveDeps = { ...base.deps, isTty: () => true, confirm: vi.fn() };
    const code = await runToolRemove('personal__my_tool', { yes: true }, deps);
    expect(code).toBe(1);
    expect(base.stderr.value).toContain('tlbx init');
  });
});
