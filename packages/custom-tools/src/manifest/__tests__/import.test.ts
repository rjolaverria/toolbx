import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importTool, ToolImportError, type ToolManifest } from '../import.js';

/** The SPECS §6.2 example tool source. */
const SPEC_EXAMPLE = `/**
 * @toolbox-tool name send_slack_summary
 * @toolbox-tool title Send Slack Summary
 * @toolbox-tool description Summarize text and send it to a configured Slack channel.
 * @toolbox-tool namespace personal
 */

import { z } from 'zod';

export const inputSchema = z.object({
  channel: z.string().describe('Slack channel ID or name'),
  summary: z.string().describe('Summary text to send'),
});

export default async function sendSlackSummary(input: { channel: string; summary: string }) {
  return {
    content: [
      {
        type: 'text',
        text: \`Sent summary to \${input.channel}\`,
      },
    ],
  };
}
`;

let configDir: string;
let sourceDir: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-import-cfg-'));
  sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-import-src-'));
});

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

async function writeSource(name: string, contents: string): Promise<string> {
  const file = path.join(sourceDir, name);
  await fs.writeFile(file, contents, 'utf8');
  return file;
}

async function readManifestFile(): Promise<ToolManifest[]> {
  const raw = await fs.readFile(path.join(configDir, 'tools', 'manifest.json'), 'utf8');
  return JSON.parse(raw) as ToolManifest[];
}

describe('importTool', () => {
  it('imports the SPECS §6.2 example into the §6.3 manifest shape with import defaults', async () => {
    const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);

    const result = await importTool(sourcePath, { configDir });

    expect(result.manifest).toEqual({
      name: 'send_slack_summary',
      namespace: 'personal',
      exposedName: 'personal__send_slack_summary',
      title: 'Send Slack Summary',
      description: 'Summarize text and send it to a configured Slack channel.',
      entry: 'tools/personal/send_slack_summary.ts',
      runtime: 'node',
      enabled: false,
      permissions: { network: false, filesystem: false, env: [] },
    });
    expect(result.warnings).toEqual([]);
  });

  it('copies the source file into the toolbox tools directory verbatim', async () => {
    const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);

    const result = await importTool(sourcePath, { configDir });

    const expectedPath = path.join(configDir, 'tools', 'personal', 'send_slack_summary.ts');
    expect(result.entryPath).toBe(expectedPath);
    await expect(fs.readFile(expectedPath, 'utf8')).resolves.toBe(SPEC_EXAMPLE);
  });

  it('stores the entry under tools/, never under a path named with the tlbx alias', async () => {
    const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);

    const result = await importTool(sourcePath, { configDir });

    expect(result.manifest.entry).toBe('tools/personal/send_slack_summary.ts');
    expect(result.manifest.entry).not.toContain('tlbx');
  });

  it('writes the central manifest list at tools/manifest.json', async () => {
    const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);

    await importTool(sourcePath, { configDir });

    const manifest = await readManifestFile();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.exposedName).toBe('personal__send_slack_summary');
  });

  it('appends additional tools to the central manifest list', async () => {
    await importTool(await writeSource('send_slack_summary.ts', SPEC_EXAMPLE), { configDir });
    const second = SPEC_EXAMPLE.replace('send_slack_summary', 'send_email').replace(
      'sendSlackSummary',
      'sendEmail',
    );
    await importTool(await writeSource('send_email.ts', second), { configDir });

    const manifest = await readManifestFile();
    expect(manifest.map((m) => m.exposedName).sort()).toEqual([
      'personal__send_email',
      'personal__send_slack_summary',
    ]);
  });

  it('preserves the file extension for .js tools', async () => {
    const js = SPEC_EXAMPLE.replace(': { channel: string; summary: string }', '');
    const sourcePath = await writeSource('send_slack_summary.js', js);

    const result = await importTool(sourcePath, { configDir });

    expect(result.manifest.entry).toBe('tools/personal/send_slack_summary.js');
    expect(result.manifest.runtime).toBe('node');
  });

  it('surfaces unknown @toolbox-tool directives as warnings', async () => {
    const withUnknown = SPEC_EXAMPLE.replace(
      '@toolbox-tool namespace personal',
      '@toolbox-tool namespace personal\n * @toolbox-tool category messaging',
    );
    const sourcePath = await writeSource('send_slack_summary.ts', withUnknown);

    const result = await importTool(sourcePath, { configDir });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain('category');
  });

  describe('collisions', () => {
    it('refuses to overwrite an existing custom tool without force', async () => {
      const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);
      await importTool(sourcePath, { configDir });

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'tool-exists',
      });
    });

    it('names the colliding exposed name in the error', async () => {
      const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);
      await importTool(sourcePath, { configDir });

      await expect(importTool(sourcePath, { configDir })).rejects.toThrow(
        /personal__send_slack_summary/,
      );
    });

    it('overwrites an existing custom tool when force is set', async () => {
      const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);
      await importTool(sourcePath, { configDir });

      const updated = SPEC_EXAMPLE.replace(
        'Summarize text and send it to a configured Slack channel.',
        'Updated description.',
      );
      await fs.writeFile(sourcePath, updated, 'utf8');
      const result = await importTool(sourcePath, { configDir, force: true });

      expect(result.manifest.description).toBe('Updated description.');
      const manifest = await readManifestFile();
      expect(manifest).toHaveLength(1);
      expect(manifest[0]?.description).toBe('Updated description.');
    });

    it('rejects a namespace that collides with a configured upstream server name', async () => {
      const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);

      await expect(
        importTool(sourcePath, { configDir, serverNames: ['github', 'personal'] }),
      ).rejects.toMatchObject({ name: 'ToolImportError', code: 'namespace-collision' });
    });
  });

  describe('shape validation', () => {
    it('rejects a tool with no default export', async () => {
      const noDefault = SPEC_EXAMPLE.replace('export default async function', 'async function');
      const sourcePath = await writeSource('send_slack_summary.ts', noDefault);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'invalid-shape',
      });
      await expect(importTool(sourcePath, { configDir })).rejects.toThrow(/default/);
    });

    it('rejects a default export that is not a function', async () => {
      const notFn = SPEC_EXAMPLE.replace(
        /export default async function[\s\S]*$/,
        'export default 42;\n',
      );
      const sourcePath = await writeSource('send_slack_summary.ts', notFn);

      await expect(importTool(sourcePath, { configDir })).rejects.toThrow(/default/);
    });

    it('rejects a tool with no inputSchema export', async () => {
      const noSchema = SPEC_EXAMPLE.replace('export const inputSchema', 'const inputSchema');
      const sourcePath = await writeSource('send_slack_summary.ts', noSchema);

      await expect(importTool(sourcePath, { configDir })).rejects.toThrow(/inputSchema/);
    });

    it('rejects a tool whose inputSchema export is a primitive, not a schema', async () => {
      const primitive = SPEC_EXAMPLE.replace(
        /export const inputSchema = z\.object\(\{[\s\S]*?\}\);/,
        'export const inputSchema = 42;',
      );
      const sourcePath = await writeSource('send_slack_summary.ts', primitive);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'invalid-shape',
      });
      await expect(importTool(sourcePath, { configDir })).rejects.toThrow(/inputSchema/);
    });

    it('rejects a namespace that contains the namespace separator', async () => {
      // `github__foo` + name `bar` would expose `github__foo__bar`, which is
      // indistinguishable from proxied server `github` tool `foo__bar`.
      const ambiguous = SPEC_EXAMPLE.replace(
        '@toolbox-tool namespace personal',
        '@toolbox-tool namespace github__foo',
      );
      const sourcePath = await writeSource('send_slack_summary.ts', ambiguous);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'invalid-identifier',
      });
      await expect(fs.readdir(path.join(configDir, 'tools'))).rejects.toThrow();
    });

    it('rejects a namespace containing a configured non-default separator', async () => {
      // `team-a` passes the server-name charset but contains the configured `-`
      // separator, so the exposed name would be ambiguous.
      const sourcePath = await writeSource(
        'send_slack_summary.ts',
        SPEC_EXAMPLE.replace('@toolbox-tool namespace personal', '@toolbox-tool namespace team-a'),
      );

      await expect(importTool(sourcePath, { configDir, separator: '-' })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'invalid-identifier',
      });
    });

    it('rejects a namespace containing path traversal segments', async () => {
      const traversal = SPEC_EXAMPLE.replace(
        '@toolbox-tool namespace personal',
        '@toolbox-tool namespace ../../etc',
      );
      const sourcePath = await writeSource('send_slack_summary.ts', traversal);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'invalid-identifier',
      });
      // Nothing should have been written outside the tools directory.
      await expect(fs.readdir(path.join(configDir, 'tools'))).rejects.toThrow();
    });

    it('rejects a tool with relative imports it cannot relocate', async () => {
      const withRelative = SPEC_EXAMPLE.replace(
        "import { z } from 'zod';",
        "import { z } from 'zod';\nimport { helper } from './helper.js';",
      ).replace('return {', 'void helper;\n  return {');
      const sourcePath = await writeSource('send_slack_summary.ts', withRelative);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'relative-import',
      });
      await expect(fs.readdir(path.join(configDir, 'tools'))).rejects.toThrow();
    });

    it('rejects a tool that re-exports inputSchema from a relative module', async () => {
      const reexport = `/**
 * @toolbox-tool name send_slack_summary
 * @toolbox-tool title Send Slack Summary
 * @toolbox-tool description Summarize text and send it to a configured Slack channel.
 * @toolbox-tool namespace personal
 */
export { inputSchema } from './schema.js';
export default async function f() {
  return { content: [] };
}
`;
      const sourcePath = await writeSource('send_slack_summary.ts', reexport);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'relative-import',
      });
    });

    it('rejects a tool using `import = require(...)` for a relative module', async () => {
      const eqReq = SPEC_EXAMPLE.replace(
        "import { z } from 'zod';",
        "import { z } from 'zod';\nimport helper = require('./helper');",
      ).replace('return {', 'void helper;\n  return {');
      const sourcePath = await writeSource('send_slack_summary.ts', eqReq);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'relative-import',
      });
    });

    it('rejects a tool with a computed dynamic import', async () => {
      const computed = SPEC_EXAMPLE.replace(
        'return {',
        "const extra = await import('./' + input.channel + '.js');\n  void extra;\n  return {",
      );
      const sourcePath = await writeSource('send_slack_summary.ts', computed);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'dynamic-import',
      });
    });

    it('imports a tool that only has a type-only relative import', async () => {
      const withTypeImport = SPEC_EXAMPLE.replace(
        "import { z } from 'zod';",
        "import type { Foo } from './types.js';\nimport { z } from 'zod';",
      );
      const sourcePath = await writeSource('send_slack_summary.ts', withTypeImport);

      const result = await importTool(sourcePath, { configDir });
      expect(result.manifest.exposedName).toBe('personal__send_slack_summary');
    });

    it('rejects a tool with a syntax error', async () => {
      const broken = SPEC_EXAMPLE.replace(
        'export const inputSchema = z.object({',
        'export const inputSchema = z.object({ ;',
      );
      const sourcePath = await writeSource('send_slack_summary.ts', broken);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'syntax-error',
      });
    });

    it('rejects an unsupported file extension', async () => {
      const sourcePath = await writeSource('send_slack_summary.py', SPEC_EXAMPLE);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'unsupported-extension',
      });
    });
  });

  describe('existing manifest validation', () => {
    async function writeManifestRaw(contents: string): Promise<void> {
      const toolsDir = path.join(configDir, 'tools');
      await fs.mkdir(toolsDir, { recursive: true });
      await fs.writeFile(path.join(toolsDir, 'manifest.json'), contents, 'utf8');
    }

    it('rejects a manifest file that is not valid JSON', async () => {
      await writeManifestRaw('{ not json');
      const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'invalid-manifest',
      });
    });

    it('rejects a manifest file that does not match the schema', async () => {
      await writeManifestRaw(JSON.stringify([{ name: 'oops' }]));
      const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);

      await expect(importTool(sourcePath, { configDir })).rejects.toMatchObject({
        name: 'ToolImportError',
        code: 'invalid-manifest',
      });
    });

    it('preserves unknown fields on existing manifest entries when importing another tool', async () => {
      const existing = {
        name: 'other_tool',
        namespace: 'personal',
        exposedName: 'personal__other_tool',
        title: 'Other',
        description: 'Another tool.',
        entry: 'tools/personal/other_tool.ts',
        runtime: 'node',
        enabled: true,
        permissions: { network: false, filesystem: false, env: [], futurePerm: 'keep-too' },
        futureField: 'keep-me',
      };
      await writeManifestRaw(JSON.stringify([existing]));

      await importTool(await writeSource('send_slack_summary.ts', SPEC_EXAMPLE), { configDir });

      const manifest = await readManifestFile();
      const preserved = manifest.find(
        (m) => m.exposedName === 'personal__other_tool',
      ) as unknown as Record<string, unknown> | undefined;
      expect(preserved?.futureField).toBe('keep-me');
      expect((preserved?.permissions as Record<string, unknown>).futurePerm).toBe('keep-too');
    });
  });

  it('honours a custom namespace separator in the exposed name', async () => {
    const sourcePath = await writeSource('send_slack_summary.ts', SPEC_EXAMPLE);

    const result = await importTool(sourcePath, { configDir, separator: '.' });

    expect(result.manifest.exposedName).toBe('personal.send_slack_summary');
  });

  it('is an instance of ToolImportError on failure', async () => {
    const sourcePath = await writeSource('send_slack_summary.py', SPEC_EXAMPLE);
    await expect(importTool(sourcePath, { configDir })).rejects.toBeInstanceOf(ToolImportError);
  });
});
