/**
 * Pure JSDoc metadata parser for custom tool files (SPECS §6.2).
 *
 * Extracts the `@toolbox-tool` directives from a user-provided `.ts` / `.js`
 * source string. This module never evaluates the file — it reads the JSDoc
 * comment block and uses the TypeScript parser to note whether an `inputSchema`
 * binding is exported, so the importer (P3-02) can validate it later.
 */

import ts from 'typescript';

/** The four required `@toolbox-tool` directives, in canonical order. */
const REQUIRED_DIRECTIVES = ['name', 'title', 'description', 'namespace'] as const;

type RequiredDirective = (typeof REQUIRED_DIRECTIVES)[number];

export interface ParseWarning {
  /** 1-based line in the source where the offending directive appears. */
  readonly line: number;
  readonly message: string;
}

export interface ParseIssue {
  /** 1-based line, when the problem is tied to a specific directive line. */
  readonly line?: number;
  readonly message: string;
}

export interface ParsedToolMetadata {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly namespace: string;
  /** Whether the source exports an `inputSchema` binding (not evaluated). */
  readonly hasInputSchema: boolean;
  readonly warnings: readonly ParseWarning[];
}

/**
 * Raised when a tool file's `@toolbox-tool` metadata cannot be parsed. Carries
 * every problem found so the importer can show them all at once, and renders a
 * friendly message that names the source path and each offending line.
 */
export class ToolMetadataParseError extends Error {
  override readonly name = 'ToolMetadataParseError';
  readonly filename: string;
  readonly issues: readonly ParseIssue[];

  constructor(filename: string, issues: readonly ParseIssue[]) {
    const detail = issues
      .map((issue) =>
        typeof issue.line === 'number'
          ? `  ${filename}:${issue.line}: ${issue.message}`
          : `  ${filename}: ${issue.message}`,
      )
      .join('\n');
    super(`Failed to parse tool metadata in ${filename}:\n${detail}`);
    this.filename = filename;
    this.issues = issues;
  }
}

interface RawDirective {
  readonly key: string;
  readonly value: string;
  readonly line: number;
}

const DIRECTIVE = /@toolbox-tool[ \t]+(\S+)[ \t]*(.*)$/;

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

/** Whether a top-level statement is a runtime `export const|let|var inputSchema`. */
function isInputSchemaVariableExport(statement: ts.Statement): boolean {
  return (
    ts.isVariableStatement(statement) &&
    hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
    // `export declare const inputSchema` is ambient — it emits no runtime binding.
    !hasModifier(statement, ts.SyntaxKind.DeclareKeyword) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'inputSchema',
    )
  );
}

/** Whether a top-level statement re-exports a runtime binding as `inputSchema`. */
function isInputSchemaNamedExport(statement: ts.Statement): boolean {
  return (
    ts.isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    statement.exportClause !== undefined &&
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.some(
      (element) => !element.isTypeOnly && element.name.text === 'inputSchema',
    )
  );
}

/**
 * Reports whether the source exports a runtime binding named `inputSchema`.
 *
 * Uses the TypeScript parser rather than a text scan so comments, string /
 * template literals, and regex literals that merely contain the text are never
 * mistaken for an export. The source is parsed, never evaluated. TypeScript is
 * a superset of JavaScript, so parsing as `ScriptKind.TS` covers both `.ts` and
 * `.js` tool files.
 *
 * Only top-level statements are inspected — a binding exported from inside a
 * `namespace` or ambient module block is not a module export. Recognised forms:
 *
 *   - `export const | let | var inputSchema = ...`
 *   - `export { inputSchema }` and `export { local as inputSchema }`
 *
 * Excluded: ambient `export declare` bindings, type-only exports
 * (`export type { inputSchema }`, `export { type inputSchema }`), and re-aliases
 * away from the name (`export { inputSchema as other }`).
 */
function hasInputSchemaExport(source: string, filename: string): boolean {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );

  return sourceFile.statements.some(
    (statement) => isInputSchemaVariableExport(statement) || isInputSchemaNamedExport(statement),
  );
}

function lineAt(source: string, index: number): number {
  let line = 1;
  const end = Math.min(index, source.length);
  for (let i = 0; i < end; i++) {
    if (source[i] === '\n') {
      line++;
    }
  }
  return line;
}

/** Extracts the `@toolbox-tool` directives found in a single comment's text. */
function directivesInComment(
  commentText: string,
  commentStart: number,
  source: string,
): RawDirective[] {
  const directives: RawDirective[] = [];
  let offset = 0;
  for (const rawLine of commentText.split('\n')) {
    const directiveMatch = DIRECTIVE.exec(rawLine);
    if (directiveMatch) {
      const key = directiveMatch[1] ?? '';
      const value = (directiveMatch[2] ?? '').replace(/\*\/\s*$/, '').trimEnd();
      directives.push({ key, value, line: lineAt(source, commentStart + offset) });
    }
    offset += rawLine.length + 1; // + 1 for the consumed newline
  }
  return directives;
}

/**
 * Returns one entry per JSDoc block comment (opening with a double asterisk)
 * that contains at least one directive. Uses the TypeScript scanner to
 * enumerate real comment trivia, so JSDoc-looking text inside a string or
 * template literal is never mistaken for a metadata block.
 */
function findToolBlocks(source: string): RawDirective[][] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source,
  );
  const blocks: RawDirective[][] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.MultiLineCommentTrivia) {
      continue;
    }
    const text = scanner.getTokenText();
    if (!text.startsWith('/**')) {
      continue;
    }
    const directives = directivesInComment(text, scanner.getTokenStart(), source);
    if (directives.length > 0) {
      blocks.push(directives);
    }
  }
  return blocks;
}

export function parseToolMetadata(source: string, filename: string): ParsedToolMetadata {
  const blocks = findToolBlocks(source);

  if (blocks.length === 0) {
    throw new ToolMetadataParseError(filename, [
      {
        message:
          'no @toolbox-tool directives found; expected a JSDoc block with @toolbox-tool name/title/description/namespace',
      },
    ]);
  }

  if (blocks.length > 1) {
    const duplicates = blocks.slice(1).map((block) => {
      const line = block[0]?.line;
      return {
        ...(typeof line === 'number' ? { line } : {}),
        message: 'multiple @toolbox-tool blocks found; only one is allowed',
      };
    });
    throw new ToolMetadataParseError(filename, duplicates);
  }

  const directives = blocks[0] ?? [];
  const values = new Map<string, string>();
  const warnings: ParseWarning[] = [];
  const required = new Set<string>(REQUIRED_DIRECTIVES);

  for (const directive of directives) {
    if (required.has(directive.key)) {
      values.set(directive.key, directive.value);
    } else {
      warnings.push({
        line: directive.line,
        message: `unknown @toolbox-tool directive: ${directive.key}`,
      });
    }
  }

  const missing = REQUIRED_DIRECTIVES.filter((key) => {
    const value = values.get(key);
    return value === undefined || value.length === 0;
  });

  if (missing.length > 0) {
    throw new ToolMetadataParseError(
      filename,
      missing.map((key) => ({ message: `missing required @toolbox-tool directive: ${key}` })),
    );
  }

  const read = (key: RequiredDirective): string => values.get(key) ?? '';

  return {
    name: read('name'),
    title: read('title'),
    description: read('description'),
    namespace: read('namespace'),
    hasInputSchema: hasInputSchemaExport(source, filename),
    warnings,
  };
}
