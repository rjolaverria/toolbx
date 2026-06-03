import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importTool } from '../import.js';
import {
  findToolByExposedName,
  readToolManifest,
  removeTool,
  setToolEnabled,
  ToolManifestError,
  toolsManifestPath,
  writeToolManifest,
} from '../store.js';

const SPEC_EXAMPLE = `/**
 * @toolbox-tool name send_slack_summary
 * @toolbox-tool title Send Slack Summary
 * @toolbox-tool description Summarize text and send it to a configured Slack channel.
 * @toolbox-tool namespace personal
 */

export const inputSchema = { type: 'object', properties: {}, additionalProperties: false };

export default async function sendSlackSummary() {
  return { content: [{ type: 'text', text: 'ok' }] };
}
`;

let configDir: string;
let sourceDir: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-store-cfg-'));
  sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-store-src-'));
});

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

async function importExample(): Promise<string> {
  const sourcePath = path.join(sourceDir, 'send_slack_summary.ts');
  await fs.writeFile(sourcePath, SPEC_EXAMPLE, 'utf8');
  const result = await importTool(sourcePath, { configDir });
  return result.manifest.exposedName;
}

describe('readToolManifest', () => {
  it('returns an empty list when no manifest exists', async () => {
    await expect(readToolManifest(configDir)).resolves.toEqual([]);
  });

  it('reads the entries written by the importer', async () => {
    await importExample();
    const entries = await readToolManifest(configDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.exposedName).toBe('personal__send_slack_summary');
  });

  it('throws ToolManifestError on invalid JSON', async () => {
    await fs.mkdir(path.dirname(toolsManifestPath(configDir)), { recursive: true });
    await fs.writeFile(toolsManifestPath(configDir), 'not json', 'utf8');
    await expect(readToolManifest(configDir)).rejects.toMatchObject({
      name: 'ToolManifestError',
      code: 'invalid-manifest',
    });
  });

  it('throws ToolManifestError when the shape is wrong', async () => {
    await writeToolManifest(configDir, []);
    await fs.writeFile(toolsManifestPath(configDir), JSON.stringify([{ name: 'x' }]), 'utf8');
    await expect(readToolManifest(configDir)).rejects.toMatchObject({ code: 'invalid-manifest' });
  });
});

describe('findToolByExposedName', () => {
  it('finds an entry by exposed name', async () => {
    await importExample();
    const entries = await readToolManifest(configDir);
    expect(findToolByExposedName(entries, 'personal__send_slack_summary')?.name).toBe(
      'send_slack_summary',
    );
  });

  it('returns undefined when absent', () => {
    expect(findToolByExposedName([], 'nope__missing')).toBeUndefined();
  });
});

describe('setToolEnabled', () => {
  it('enables a disabled tool and persists the change', async () => {
    const exposedName = await importExample();
    const result = await setToolEnabled(configDir, exposedName, true);
    expect(result.changed).toBe(true);
    expect(result.manifest.enabled).toBe(true);
    const entries = await readToolManifest(configDir);
    expect(entries[0]?.enabled).toBe(true);
  });

  it('reports no change when already in the requested state', async () => {
    const exposedName = await importExample();
    const result = await setToolEnabled(configDir, exposedName, false);
    expect(result.changed).toBe(false);
    expect(result.manifest.enabled).toBe(false);
  });

  it('throws tool-not-found for an unknown name', async () => {
    await expect(setToolEnabled(configDir, 'nope__missing', true)).rejects.toMatchObject({
      code: 'tool-not-found',
    });
  });
});

describe('removeTool', () => {
  it('removes the source file and the manifest entry', async () => {
    const exposedName = await importExample();
    const entryPath = path.join(configDir, 'tools', 'personal', 'send_slack_summary.ts');

    const result = await removeTool(configDir, exposedName);

    expect(result.sourceRemoved).toBe(true);
    expect(result.entryPath).toBe(entryPath);
    await expect(fs.access(entryPath)).rejects.toThrow();
    await expect(readToolManifest(configDir)).resolves.toEqual([]);
  });

  it('still drops the manifest entry when the source file is already gone', async () => {
    const exposedName = await importExample();
    const entryPath = path.join(configDir, 'tools', 'personal', 'send_slack_summary.ts');
    await fs.rm(entryPath);

    const result = await removeTool(configDir, exposedName);

    expect(result.sourceRemoved).toBe(false);
    await expect(readToolManifest(configDir)).resolves.toEqual([]);
  });

  it('throws tool-not-found for an unknown name', async () => {
    await expect(removeTool(configDir, 'nope__missing')).rejects.toBeInstanceOf(ToolManifestError);
  });
});
