import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { readToolManifest } from '@toolbox/custom-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runToolImport, type ToolImportDeps } from '../tool-import.js';
import { makeHarness, makeTempConfig, type ConfigHarness } from './harness.js';

const TOOL_SOURCE = `/**
 * @toolbox-tool name send_slack_summary
 * @toolbox-tool title Send Slack Summary
 * @toolbox-tool description Summarize text and send it to Slack.
 * @toolbox-tool namespace personal
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

async function writeSource(source = TOOL_SOURCE, file = 'incoming.ts'): Promise<string> {
  const sourcePath = path.join(harness.dir, file);
  await fs.writeFile(sourcePath, source, 'utf8');
  return sourcePath;
}

interface ImportHarness {
  deps: ToolImportDeps;
  stdout: { value: string };
  stderr: { value: string };
  confirm: ReturnType<typeof vi.fn>;
}

function makeImportHarness(answer: boolean, tty = true, target = harness.target): ImportHarness {
  const base = makeHarness(target);
  const confirm = vi.fn().mockResolvedValue(answer);
  const deps: ToolImportDeps = { ...base.deps, isTty: () => tty, confirm };
  return { deps, stdout: base.stdout, stderr: base.stderr, confirm };
}

describe('runToolImport', () => {
  it('previews permissions, prompts, and imports the tool disabled on confirmation', async () => {
    const sourcePath = await writeSource();
    const { deps, stdout, confirm } = makeImportHarness(true);

    const code = await runToolImport(sourcePath, {}, deps);

    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(stdout.value).toContain('exposed as:  personal__send_slack_summary');
    expect(stdout.value).toContain('Permissions:');
    expect(stdout.value).toContain('network:');
    expect(stdout.value).toContain('Imported "personal__send_slack_summary" (disabled)');

    const entries = await readToolManifest(harness.dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.enabled).toBe(false);
  });

  it('does not write anything when the user declines', async () => {
    const sourcePath = await writeSource();
    const { deps, stderr, confirm } = makeImportHarness(false);

    const code = await runToolImport(sourcePath, {}, deps);

    expect(code).toBe(1);
    expect(confirm).toHaveBeenCalledOnce();
    expect(stderr.value).toContain('was not imported');
    await expect(readToolManifest(harness.dir)).resolves.toEqual([]);
    // The tools directory must not have been created by a declined import.
    await expect(fs.access(path.join(harness.dir, 'tools'))).rejects.toThrow();
  });

  it('skips confirmation with --yes', async () => {
    const sourcePath = await writeSource();
    const { deps, confirm } = makeImportHarness(false);

    const code = await runToolImport(sourcePath, { yes: true }, deps);

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    await expect(readToolManifest(harness.dir)).resolves.toHaveLength(1);
  });

  it('refuses without --yes in a non-interactive shell', async () => {
    const sourcePath = await writeSource();
    const { deps, stderr } = makeImportHarness(true, false);

    const code = await runToolImport(sourcePath, {}, deps);

    expect(code).toBe(2);
    expect(stderr.value).toContain('Re-run with --yes');
    await expect(readToolManifest(harness.dir)).resolves.toEqual([]);
  });

  it('reports a metadata error and writes nothing', async () => {
    const sourcePath = await writeSource('export const inputSchema = {};\n');
    const { deps, stderr } = makeImportHarness(true);

    const code = await runToolImport(sourcePath, { yes: true }, deps);

    expect(code).toBe(1);
    expect(stderr.value).toContain('@toolbox-tool');
    await expect(readToolManifest(harness.dir)).resolves.toEqual([]);
  });

  it('reports a missing config and tells the user to init', async () => {
    const missingTarget = path.join(harness.dir, 'missing', 'config.json');
    const sourcePath = await writeSource();
    const { deps, stderr } = makeImportHarness(true, true, missingTarget);

    const code = await runToolImport(sourcePath, { yes: true }, deps);

    expect(code).toBe(1);
    expect(stderr.value).toContain('tlbx init');
  });
});
