import { describe, expect, it } from 'vitest';

import { parseToolMetadata, ToolMetadataParseError } from '../parse.js';

// The canonical example from SPECS §6.2.
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

describe('parseToolMetadata', () => {
  it('parses the SPECS §6.2 example into the exact metadata', () => {
    const result = parseToolMetadata(SPEC_EXAMPLE, './send_slack_summary.ts');

    expect(result.name).toBe('send_slack_summary');
    expect(result.title).toBe('Send Slack Summary');
    expect(result.description).toBe('Summarize text and send it to a configured Slack channel.');
    expect(result.namespace).toBe('personal');
    expect(result.hasInputSchema).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it.each(['name', 'title', 'description', 'namespace'] as const)(
    'throws naming the missing required directive %s and the source path',
    (missing) => {
      const source = SPEC_EXAMPLE.split('\n')
        .filter((line) => !line.includes(`@toolbox-tool ${missing} `))
        .join('\n');

      let thrown: unknown;
      try {
        parseToolMetadata(source, './broken.ts');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ToolMetadataParseError);
      const err = thrown as ToolMetadataParseError;
      expect(err.filename).toBe('./broken.ts');
      expect(err.message).toContain(missing);
      expect(err.message).toContain('./broken.ts');
    },
  );

  it('reports every missing required directive at once', () => {
    let thrown: unknown;
    try {
      parseToolMetadata('/**\n * @toolbox-tool name only_name\n */\n', './partial.ts');
    } catch (error) {
      thrown = error;
    }

    const err = thrown as ToolMetadataParseError;
    expect(err.message).toContain('title');
    expect(err.message).toContain('description');
    expect(err.message).toContain('namespace');
    expect(err.message).not.toContain('name require');
  });

  it('surfaces unknown @toolbox-tool directives as warnings without failing', () => {
    const source = SPEC_EXAMPLE.replace(
      ' * @toolbox-tool namespace personal\n',
      ' * @toolbox-tool namespace personal\n * @toolbox-tool category fun\n',
    );

    const result = parseToolMetadata(source, './extra.ts');

    expect(result.namespace).toBe('personal');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain('category');
    expect(result.warnings[0]?.line).toBeGreaterThan(0);
  });

  it('detects the absence of an inputSchema export', () => {
    const source = `/**
 * @toolbox-tool name no_schema
 * @toolbox-tool title No Schema
 * @toolbox-tool description A tool without an input schema.
 * @toolbox-tool namespace personal
 */

export default async function noSchema() {
  return { content: [] };
}
`;

    const result = parseToolMetadata(source, './no_schema.ts');

    expect(result.hasInputSchema).toBe(false);
  });

  const META = `/**
 * @toolbox-tool name no_schema
 * @toolbox-tool title No Schema
 * @toolbox-tool description A tool without an input schema.
 * @toolbox-tool namespace personal
 */
`;

  it('does not treat `export const inputSchema` inside a line comment as a real export', () => {
    const source = `${META}\n// export const inputSchema = z.object({});\nexport default async function f() {\n  return { content: [] };\n}\n`;

    expect(parseToolMetadata(source, './commented.ts').hasInputSchema).toBe(false);
  });

  it('does not treat `export const inputSchema` inside a block comment as a real export', () => {
    const source = `${META}\n/* export const inputSchema = z.object({}); */\nexport default async function f() {\n  return { content: [] };\n}\n`;

    expect(parseToolMetadata(source, './block.ts').hasInputSchema).toBe(false);
  });

  it('does not treat `export const inputSchema` inside a string literal as a real export', () => {
    const source = `${META}\nconst doc = 'export const inputSchema = ...';\nexport default async function f() {\n  return { content: [{ type: 'text', text: doc }] };\n}\n`;

    expect(parseToolMetadata(source, './string.ts').hasInputSchema).toBe(false);
  });

  it('does not treat `export const inputSchema` inside a double-quoted string as a real export', () => {
    const source = `${META}\nconst doc = "export const inputSchema = ...";\nexport default async function f() {\n  return { content: [] };\n}\n`;

    expect(parseToolMetadata(source, './double.ts').hasInputSchema).toBe(false);
  });

  it('does not treat `export const inputSchema` inside a template literal as a real export', () => {
    const source = `${META}\nconst doc = \`export const inputSchema = \${1}\`;\nexport default async function f() {\n  return { content: [] };\n}\n`;

    expect(parseToolMetadata(source, './template.ts').hasInputSchema).toBe(false);
  });

  it('does not treat `export const inputSchema` inside a multi-line block comment as a real export', () => {
    const source = `${META}\n/*\n  export const inputSchema = z.object({});\n*/\nexport default async function f() {\n  return { content: [] };\n}\n`;

    expect(parseToolMetadata(source, './multiblock.ts').hasInputSchema).toBe(false);
  });

  it('handles escaped quotes inside a string without ending it early', () => {
    const source = `${META}\nconst doc = 'it\\'s not: export const inputSchema here';\nexport default async function f() {\n  return { content: [] };\n}\n`;

    expect(parseToolMetadata(source, './escaped.ts').hasInputSchema).toBe(false);
  });

  it('still detects a real inputSchema export alongside a misleading comment', () => {
    const source = `${META}\nimport { z } from 'zod';\n// not this: export const inputSchema in a comment\nexport const inputSchema = z.object({ a: z.string() });\nexport default async function f() {\n  return { content: [] };\n}\n`;

    expect(parseToolMetadata(source, './real.ts').hasInputSchema).toBe(true);
  });

  it('throws when the source has no @toolbox-tool directives at all', () => {
    const source = `// just a plain module\nexport default function f() {\n  return { content: [] };\n}\n`;

    let thrown: unknown;
    try {
      parseToolMetadata(source, './plain.ts');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ToolMetadataParseError);
    const err = thrown as ToolMetadataParseError;
    expect(err.message).toContain('no @toolbox-tool directives');
    expect(err.message).toContain('./plain.ts');
  });

  it('rejects multiple @toolbox-tool blocks and reports the duplicate line', () => {
    const source = `/**
 * @toolbox-tool name first
 * @toolbox-tool title First
 * @toolbox-tool description The first block.
 * @toolbox-tool namespace personal
 */

/**
 * @toolbox-tool name second
 */

export default async function f() {
  return { content: [] };
}
`;

    let thrown: unknown;
    try {
      parseToolMetadata(source, './dupe.ts');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ToolMetadataParseError);
    const err = thrown as ToolMetadataParseError;
    expect(err.message.toLowerCase()).toContain('multiple');
    expect(err.issues.some((issue) => typeof issue.line === 'number')).toBe(true);
  });
});
