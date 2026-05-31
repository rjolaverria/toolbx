/**
 * Pure JSDoc metadata parser for custom tool files (SPECS §6.2).
 *
 * Extracts the `@toolbox-tool` directives from a user-provided `.ts` / `.js`
 * source string. This module never evaluates the file — it reads the JSDoc
 * comment block and uses the TypeScript parser to note whether an `inputSchema`
 * binding and a callable default export are present, so the importer (P3-02)
 * can validate the tool's shape later.
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
  /**
   * Whether the source exports a plausibly schema-shaped `inputSchema` binding
   * (a runtime value that is not a primitive). Not evaluated — full Zod / JSON
   * Schema value validation happens when the runtime loader runs the file
   * (P3-03).
   */
  readonly hasInputSchema: boolean;
  /**
   * Whether the source has a default export whose type is callable (a function
   * handler). Resolved with the type checker, not evaluated. `async` is not
   * required statically — the runtime (P3-03) awaits the result regardless.
   */
  readonly hasDefaultFunctionExport: boolean;
  /**
   * Relative / absolute module specifiers the file imports or re-exports (e.g.
   * `./util.js`, `../x`, `/abs`). The importer copies only the entry file, so
   * these would dangle after relocation; it rejects a tool that has any. Bare
   * package and `node:` specifiers are not listed.
   */
  readonly relativeImports: readonly string[];
  /** Syntactic (parse) errors in the source; a tool with any cannot run. */
  readonly syntaxErrors: readonly ParseIssue[];
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
/**
 * Whether the symbol is exported through a type-only specifier or declaration
 * (`export type { x }`, `export { type x }`, with or without a `from` clause).
 * Such exports never produce a runtime binding, even when the target module is
 * not loaded here, so they must be rejected before the unresolved-alias path.
 */
function isTypeOnlyReExport(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    if (!ts.isExportSpecifier(declaration)) {
      return false;
    }
    return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
  });
}

function isRuntimeValueExport(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  if (isTypeOnlyReExport(symbol)) {
    return false;
  }

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

// Primitive type flags. A schema (Zod instance or JSON-schema object literal)
// is never one of these: a Zod call resolves to `any` here (the `zod` import is
// not loaded in the isolated program) and a JSON-schema literal is an object
// type. So a primitively-typed `inputSchema` (`= 42`, `= 'x'`, `= true`) is
// certainly not a schema and can be rejected statically. Full schema-value
// validation happens when the runtime loader evaluates the module (P3-03).
const PRIMITIVE_TYPE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void;

/**
 * Whether the export's resolved type is a primitive. Returns `false` when the
 * type cannot be determined (e.g. an unresolved cross-module re-export), so the
 * presence check stays permissive — only a positively primitive type is
 * rejected.
 */
function isPrimitiveTypedExport(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  let resolved = symbol;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(symbol);
    if ((aliased.declarations?.length ?? 0) > 0) {
      resolved = aliased;
    }
  }
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (declaration === undefined) {
    return false;
  }
  const type = checker.getTypeOfSymbolAtLocation(resolved, declaration);
  return (type.flags & PRIMITIVE_TYPE_FLAGS) !== 0;
}

/**
 * Whether the default export's type is callable (a function handler). Aliases
 * (`export { handler as default }`, `export default handler`) are followed to
 * their target when resolvable, then the type's call signatures decide. A
 * non-function default (`export default 42`) has no call signatures and fails.
 */
function isFunctionExport(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  let resolved = symbol;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(symbol);
    if ((aliased.declarations?.length ?? 0) > 0) {
      resolved = aliased;
    }
  }
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (declaration === undefined) {
    return false;
  }
  return checker.getTypeOfSymbolAtLocation(resolved, declaration).getCallSignatures().length > 0;
}

export interface StaticAnalysis {
  readonly hasInputSchema: boolean;
  readonly hasDefaultFunctionExport: boolean;
  readonly relativeImports: readonly string[];
  readonly syntaxErrors: readonly ParseIssue[];
}

/** A module specifier is relative/absolute (vs. a bare package or `node:`). */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/**
 * Collects relative / absolute module specifiers from static `import` /
 * `export ... from` declarations and dynamic `import('...')` / `require('...')`
 * calls. Bare package and `node:` specifiers are excluded — they resolve from
 * `node_modules` at runtime and survive relocation.
 */
function collectRelativeImports(sourceFile: ts.SourceFile): string[] {
  const found: string[] = [];

  const record = (node: ts.Expression | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node) && isRelativeSpecifier(node.text)) {
      found.push(node.text);
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      record(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/** Maps the source file's syntactic (parse) diagnostics to 1-based issues. */
function syntacticIssues(program: ts.Program, sourceFile: ts.SourceFile): ParseIssue[] {
  return program.getSyntacticDiagnostics(sourceFile).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.start === undefined) {
      return { message };
    }
    return {
      line: sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
      message,
    };
  });
}

/**
 * Static analysis of the tool source: whether it exports a schema-shaped
 * `inputSchema` and a callable default export, the relative module specifiers it
 * references, and any syntactic (parse) errors.
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
function analyzeExports(source: string): StaticAnalysis {
  const sourceFile = ts.createSourceFile(
    PROGRAM_FILE_NAME,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const program = createSingleFileProgram(sourceFile);
  const checker = program.getTypeChecker();
  const relativeImports = collectRelativeImports(sourceFile);
  const syntaxErrors = syntacticIssues(program, sourceFile);

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    // Not an ES module — no exports, but still surface imports / syntax errors.
    return {
      hasInputSchema: false,
      hasDefaultFunctionExport: false,
      relativeImports,
      syntaxErrors,
    };
  }

  const exports = checker.getExportsOfModule(moduleSymbol);
  const inputSchema = exports.find((symbol) => symbol.name === 'inputSchema');
  const defaultExport = exports.find((symbol) => symbol.name === 'default');

  return {
    hasInputSchema:
      inputSchema !== undefined &&
      isRuntimeValueExport(checker, inputSchema) &&
      !isPrimitiveTypedExport(checker, inputSchema),
    hasDefaultFunctionExport:
      defaultExport !== undefined && isFunctionExport(checker, defaultExport),
    relativeImports,
    syntaxErrors,
  };
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
  const exports = analyzeExports(source);

  return {
    name: read('name'),
    title: read('title'),
    description: read('description'),
    namespace: read('namespace'),
    hasInputSchema: exports.hasInputSchema,
    hasDefaultFunctionExport: exports.hasDefaultFunctionExport,
    relativeImports: exports.relativeImports,
    syntaxErrors: exports.syntaxErrors,
    warnings,
  };
}
