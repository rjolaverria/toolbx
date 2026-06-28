import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { importTool } from '@toolbx/custom-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runToolList } from '../tool-list.js';
import { makeHarness, makeTempConfig, type ConfigHarness } from './harness.js';

const TOOL_SOURCE = `/**
 * @toolbx-tool name send_slack_summary
 * @toolbx-tool title Send Slack Summary
 * @toolbx-tool description Summarize text and send it to Slack.
 * @toolbx-tool namespace personal
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

async function seedTool(source = TOOL_SOURCE, file = 'tool.ts'): Promise<string> {
  const sourcePath = path.join(harness.dir, file);
  await fs.writeFile(sourcePath, source, 'utf8');
  const result = await importTool(sourcePath, { configDir: harness.dir });
  await fs.rm(sourcePath);
  return result.manifest.exposedName;
}

describe('runToolList', () => {
  it('reports when no custom tools are imported', async () => {
    const { deps, stdout } = makeHarness(harness.target);
    const code = await runToolList({}, deps);
    expect(code).toBe(0);
    expect(stdout.value).toContain('No custom tools imported.');
  });

  it('lists imported tools in a table', async () => {
    await seedTool();
    const { deps, stdout } = makeHarness(harness.target);
    const code = await runToolList({}, deps);
    expect(code).toBe(0);
    expect(stdout.value).toContain('personal__send_slack_summary');
    expect(stdout.value).toContain('NAME');
    expect(stdout.value).toContain('no'); // disabled by default
  });

  it('emits JSON with the documented fields', async () => {
    await seedTool();
    const { deps, stdout } = makeHarness(harness.target);
    const code = await runToolList({ json: true }, deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.value) as Array<Record<string, unknown>>;
    expect(parsed).toEqual([
      {
        name: 'send_slack_summary',
        namespace: 'personal',
        exposedName: 'personal__send_slack_summary',
        enabled: false,
      },
    ]);
  });

  it('reports a missing config and tells the user to init', async () => {
    const { deps, stderr } = makeHarness(path.join(harness.dir, 'missing', 'config.json'));
    const code = await runToolList({}, deps);
    expect(code).toBe(1);
    expect(stderr.value).toContain('tlbx init');
  });

  it('reports a corrupt manifest as an error', async () => {
    const manifestPath = path.join(harness.dir, 'tools', 'manifest.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, 'not json', 'utf8');
    const { deps, stderr } = makeHarness(harness.target);
    const code = await runToolList({}, deps);
    expect(code).toBe(1);
    expect(stderr.value).toContain('not valid JSON');
  });
});
