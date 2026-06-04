import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importTool, type ToolManifest } from '../import.js';
import {
  digestToolSources,
  findToolByExposedName,
  readToolManifest,
  removeTool,
  resolveToolEntryPath,
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

describe('digestToolSources', () => {
  it('adds a source digest to enabled tools that changes when the source changes', async () => {
    const exposedName = await importExample();
    await setToolEnabled(configDir, exposedName, true);
    const entries = await readToolManifest(configDir);

    const [first] = await digestToolSources(configDir, entries);
    expect(typeof first?.sourceDigest).toBe('string');
    expect(first?.sourceDigest).toHaveLength(64);

    // Edit the source file (metadata unchanged) and re-digest — the digest moves.
    const sourcePath = resolveToolEntryPath(configDir, entries[0]!);
    await fs.appendFile(sourcePath, '\n// edit\n', 'utf8');
    const [afterEdit] = await digestToolSources(configDir, entries);
    expect(afterEdit?.sourceDigest).not.toBe(first?.sourceDigest);
  });

  it('omits the digest for disabled tools and missing sources', async () => {
    const exposedName = await importExample(); // imported tools start disabled
    const disabled = await readToolManifest(configDir);
    const [d] = await digestToolSources(configDir, disabled);
    expect(d?.sourceDigest).toBeUndefined();

    await setToolEnabled(configDir, exposedName, true);
    const enabled = await readToolManifest(configDir);
    await fs.rm(resolveToolEntryPath(configDir, enabled[0]!));
    const [missing] = await digestToolSources(configDir, enabled);
    expect(missing?.sourceDigest).toBeUndefined();
  });
});

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

describe('writeToolManifest', () => {
  it('writes atomically, leaving no temp files behind', async () => {
    await importExample();
    await setToolEnabled(configDir, 'personal__send_slack_summary', true);

    const toolsDir = path.join(configDir, 'tools');
    const leftovers = (await fs.readdir(toolsDir)).filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);
    // The manifest is still well-formed after the rename-based write.
    const entries = await readToolManifest(configDir);
    expect(entries[0]?.enabled).toBe(true);
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

  it('refuses to enable a tool whose entry path is tampered', async () => {
    await importExample();
    const entries = await readToolManifest(configDir);
    const tampered = entries.map((entry) => ({ ...entry, entry: '../../evil.ts' }));
    await writeToolManifest(configDir, tampered);

    await expect(
      setToolEnabled(configDir, 'personal__send_slack_summary', true),
    ).rejects.toMatchObject({ code: 'invalid-manifest' });
    // It stays disabled — the tampered entry was never marked enabled.
    const after = await readToolManifest(configDir);
    expect(after[0]?.enabled).toBe(false);
  });

  it('still allows disabling a tool whose entry path is tampered', async () => {
    await importExample();
    await setToolEnabled(configDir, 'personal__send_slack_summary', true);
    const entries = await readToolManifest(configDir);
    const tampered = entries.map((entry) => ({ ...entry, entry: '../../evil.ts' }));
    await writeToolManifest(configDir, tampered);

    const result = await setToolEnabled(configDir, 'personal__send_slack_summary', false);
    expect(result.changed).toBe(true);
    const after = await readToolManifest(configDir);
    expect(after[0]?.enabled).toBe(false);
  });

  it('refuses to enable a tool whose source file is missing', async () => {
    await importExample();
    await fs.rm(path.join(configDir, 'tools', 'personal', 'send_slack_summary.ts'));

    await expect(
      setToolEnabled(configDir, 'personal__send_slack_summary', true),
    ).rejects.toMatchObject({ code: 'source-missing' });
    const after = await readToolManifest(configDir);
    expect(after[0]?.enabled).toBe(false);
  });

  it('still allows disabling a tool whose source file is missing', async () => {
    await importExample();
    await setToolEnabled(configDir, 'personal__send_slack_summary', true);
    await fs.rm(path.join(configDir, 'tools', 'personal', 'send_slack_summary.ts'));

    const result = await setToolEnabled(configDir, 'personal__send_slack_summary', false);
    expect(result.changed).toBe(true);
  });

  it('refuses to enable when the source path is a directory, not a regular file', async () => {
    await importExample();
    const entryPath = path.join(configDir, 'tools', 'personal', 'send_slack_summary.ts');
    await fs.rm(entryPath);
    await fs.mkdir(entryPath);

    await expect(
      setToolEnabled(configDir, 'personal__send_slack_summary', true),
    ).rejects.toMatchObject({ code: 'source-missing' });
    const after = await readToolManifest(configDir);
    expect(after[0]?.enabled).toBe(false);
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

  it('drops the entry and reports an orphan when the source cannot be deleted', async () => {
    const exposedName = await importExample();
    const entryPath = path.join(configDir, 'tools', 'personal', 'send_slack_summary.ts');
    // Replace the source file with a directory so fs.rm (no recursive) fails with
    // a non-ENOENT error, simulating an undeletable source.
    await fs.rm(entryPath);
    await fs.mkdir(entryPath);

    const result = await removeTool(configDir, exposedName);

    expect(result.sourceRemoved).toBe(false);
    expect(result.sourceError).toBeDefined();
    // The registry operation still succeeded: the manifest no longer lists it.
    await expect(readToolManifest(configDir)).resolves.toEqual([]);
  });

  it('refuses to delete a file a tampered entry points outside tools/', async () => {
    // A hand-edited manifest with a traversal entry must not let remove delete
    // a file outside the tools directory.
    const foreign = path.join(configDir, 'victim.ts');
    await fs.writeFile(foreign, 'do not delete me', 'utf8');
    await writeToolManifest(configDir, [
      {
        name: 'evil',
        namespace: 'personal',
        exposedName: 'personal__evil',
        title: 'Evil',
        description: 'Traversal attempt.',
        entry: '../victim.ts',
        runtime: 'node',
        enabled: false,
        timeoutMs: 30000,
        permissions: { network: false, filesystem: false, env: [] },
      },
    ]);

    await expect(removeTool(configDir, 'personal__evil')).rejects.toMatchObject({
      code: 'invalid-manifest',
    });
    // The foreign file is untouched and the manifest entry is left in place.
    await expect(fs.readFile(foreign, 'utf8')).resolves.toBe('do not delete me');
    await expect(readToolManifest(configDir)).resolves.toHaveLength(1);
  });
});

describe('resolveToolEntryPath', () => {
  function entryRecord(overrides: Partial<ToolManifest>): ToolManifest {
    return {
      name: 'my_tool',
      namespace: 'personal',
      exposedName: 'personal__my_tool',
      title: 'My Tool',
      description: 'A tool.',
      entry: 'tools/personal/my_tool.ts',
      runtime: 'node',
      enabled: false,
      timeoutMs: 30000,
      permissions: { network: false, filesystem: false, env: [] },
      ...overrides,
    };
  }

  it('resolves a canonical entry to its absolute path', () => {
    const resolved = resolveToolEntryPath(configDir, entryRecord({}));
    expect(resolved).toBe(path.join(configDir, 'tools', 'personal', 'my_tool.ts'));
  });

  it('accepts a .js stored tool', () => {
    const resolved = resolveToolEntryPath(
      configDir,
      entryRecord({ entry: 'tools/personal/my_tool.js' }),
    );
    expect(resolved).toBe(path.join(configDir, 'tools', 'personal', 'my_tool.js'));
  });

  it('rejects a parent-traversal entry', () => {
    expect(() => resolveToolEntryPath(configDir, entryRecord({ entry: '../escape.ts' }))).toThrow(
      ToolManifestError,
    );
  });

  it('rejects an absolute entry', () => {
    expect(() => resolveToolEntryPath(configDir, entryRecord({ entry: '/etc/passwd' }))).toThrow(
      ToolManifestError,
    );
  });

  it('rejects an entry pointing at the manifest or package.json', () => {
    expect(() =>
      resolveToolEntryPath(configDir, entryRecord({ entry: 'tools/manifest.json' })),
    ).toThrow(ToolManifestError);
    expect(() =>
      resolveToolEntryPath(configDir, entryRecord({ entry: 'tools/package.json' })),
    ).toThrow(ToolManifestError);
  });

  it("rejects an entry pointing at another tool's source", () => {
    // entry segments must match the record's own namespace/name.
    expect(() =>
      resolveToolEntryPath(configDir, entryRecord({ entry: 'tools/personal/other.ts' })),
    ).toThrow(ToolManifestError);
  });

  it('rejects unsafe namespace or name segments', () => {
    expect(() =>
      resolveToolEntryPath(
        configDir,
        entryRecord({ namespace: '..', entry: 'tools/../my_tool.ts' }),
      ),
    ).toThrow(ToolManifestError);
  });
});
