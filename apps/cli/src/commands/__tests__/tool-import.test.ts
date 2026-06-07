import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { importTool, readToolManifest } from '@toolbox/custom-tools';
import { loadConfig, saveConfig } from '@toolbox/core';
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

  it('reports a commit-time collision as a normal command error', async () => {
    // The confirm prompt runs between planImport and commitImport. Importing the
    // same tool there makes commitImport's re-check fail late — it must surface
    // as a command error (exit 1 + stderr), not bubble to the top-level handler.
    const sourcePath = await writeSource();
    const base = makeHarness(harness.target);
    const confirm = vi.fn().mockImplementation(async () => {
      await importTool(sourcePath, { configDir: harness.dir });
      return true;
    });
    const deps: ToolImportDeps = { ...base.deps, isTty: () => true, confirm };

    const code = await runToolImport(sourcePath, {}, deps);

    expect(code).toBe(1);
    expect(base.stderr.value).toContain('already exists');
    await expect(readToolManifest(harness.dir)).resolves.toHaveLength(1);
  });

  it('aborts when a colliding server is added during the prompt', async () => {
    // The confirm prompt runs between planImport and the pre-commit re-check.
    // Adding a server named after the tool's namespace there must make the
    // import abort rather than create a colliding flat exposed-name space.
    const sourcePath = await writeSource();
    const base = makeHarness(harness.target);
    const confirm = vi.fn().mockImplementation(async () => {
      const config = await loadConfig(harness.target);
      await saveConfig(
        {
          ...config,
          servers: {
            ...config.servers,
            personal: { type: 'stdio', enabled: true, command: 'echo', args: [] },
          },
        },
        harness.target,
      );
      return true;
    });
    const deps: ToolImportDeps = { ...base.deps, isTty: () => true, confirm };

    const code = await runToolImport(sourcePath, {}, deps);

    expect(code).toBe(1);
    expect(base.stderr.value).toContain('collides with a configured upstream server name');
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
