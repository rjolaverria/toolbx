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

// Fixed, absolute, already-normalized path for the in-memory program so
// `createProgram` does not rewrite the root name and the host always matches.
const PROGRAM_FILE_NAME = '/tool.ts';

/**
 * Builds a single-file in-memory program so the type checker can resolve module
 * exports semantically. No file system access (`noResolve`/`noLib`), and the
 * source is parsed and bound but never executed.
 */
function createSingleFileProgram(sourceFile: ts.SourceFile): ts.Program {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === PROGRAM_FILE_NAME ? sourceFile : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === PROGRAM_FILE_NAME,
    readFile: () => undefined,
  };
  return ts.createProgram([PROGRAM_FILE_NAME], { noResolve: true, noLib: true, types: [] }, host);
}

/**
 * Whether an exported symbol names a binding that exists at runtime. Type-only
 * symbols (`type` / `interface`) and ambient `declare` bindings emit nothing, so
 * they do not count. Aliases (re-exports) are followed to their target; a
 * re-export we cannot resolve (another module, not loaded here) is assumed to be
 * a value so cross-file schema re-exports still register.
 */
function isRuntimeValueExport(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  let resolved = symbol;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    // Only called when the Alias flag is set, so this never throws.
    const aliased = checker.getAliasedSymbol(symbol);
    if ((aliased.declarations?.length ?? 0) === 0) {
      // A re-export from another module not loaded here resolves to a
      // placeholder with no declarations — assume it is a value so cross-file
      // schema re-exports still register.
      return true;
    }
    resolved = aliased;
  }

  if ((resolved.flags & ts.SymbolFlags.Value) === 0) {
    return false; // type-only
  }

  // True only if a non-ambient declaration backs the value; ambient `declare`
  // bindings emit nothing at runtime.
  return (resolved.declarations ?? []).some(
    (declaration) => (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) === 0,
  );
}

/**
 * Reports whether the source exports a runtime binding named `inputSchema`.
 *
 * Uses the TypeScript type checker rather than a text scan, so comments, string
 * / template / regex literals that merely contain the text never count, and the
 * binding's meaning is resolved semantically: type-only exports
 * (`export type { inputSchema }`, `export { type inputSchema }`, or
 * `type inputSchema = ...; export { inputSchema }`), ambient `export declare`
 * bindings, nested `namespace` exports, and re-aliases away from the name
 * (`export { inputSchema as other }`) are all excluded. The source is parsed and
 * bound but never evaluated. TypeScript is a superset of JavaScript, so parsing
 * as `ScriptKind.TS` covers both `.ts` and `.js` tool files.
 */
function hasInputSchemaExport(source: string): boolean {
  const sourceFile = ts.createSourceFile(
    PROGRAM_FILE_NAME,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const checker = createSingleFileProgram(sourceFile).getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    return false; // not an ES module — no exports
  }

  const exported = checker
    .getExportsOfModule(moduleSymbol)
    .find((symbol) => symbol.name === 'inputSchema');
  return exported !== undefined && isRuntimeValueExport(checker, exported);
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
    hasInputSchema: hasInputSchemaExport(source),
    warnings,
  };
}
