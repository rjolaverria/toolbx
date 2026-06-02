/**
 * Custom tool importer (SPECS §6.2, §6.3).
 *
 * Validates a user-provided `.ts` / `.js` tool file's metadata and exported
 * shape, copies it into the ToolBox tools directory, and records it in the
 * central tool manifest. Never executes the tool — shape checks are static
 * (P3-01's type-checker pass). Evaluation and the runtime live in P3-03.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ServerNameSchema } from '@toolbox/core';
import { z } from 'zod';

import { parseToolMetadata, type ParseWarning } from './parse.js';

/** Tool source files ToolBox can import, keyed to their stored runtime. */
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.js']);

/** The tool name must be a safe path segment (no traversal). */
const IDENTIFIER = /^[A-Za-z0-9_-]+$/;

/** Default namespace separator for exposed tool names (SPECS §6.2). */
const DEFAULT_SEPARATOR = '__';

/** Sub-directory of the config directory that holds imported tools. */
const TOOLS_DIR = 'tools';
const MANIFEST_FILENAME = 'manifest.json';

/** Default per-tool execution timeout in milliseconds (SPECS §6.6). */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ToolPermissions {
  readonly network: boolean;
  readonly filesystem: boolean;
  readonly env: readonly string[];
}

export interface ToolManifest {
  readonly name: string;
  readonly namespace: string;
  readonly exposedName: string;
  readonly title: string;
  readonly description: string;
  /** Entry path relative to the config directory, POSIX-separated. */
  readonly entry: string;
  readonly runtime: 'node';
  readonly enabled: boolean;
  /** Per-tool execution timeout in milliseconds, enforced by the runtime. */
  readonly timeoutMs: number;
  readonly permissions: ToolPermissions;
}

export interface ImportToolOptions {
  /** Absolute ToolBox config directory (parent of the `tools/` directory). */
  readonly configDir: string;
  /**
   * Names of configured upstream servers. A custom-tool namespace equal to one
   * of these would let proxied and custom exposed names collide, so it is
   * rejected (SPECS design principle 4).
   */
  readonly serverNames?: readonly string[];
  /** Overwrite an existing custom tool with the same exposed name. */
  readonly force?: boolean;
  /** Namespace separator for the exposed name. Defaults to `__`. */
  readonly separator?: string;
}

export interface ImportedTool {
  readonly manifest: ToolManifest;
  /** Absolute path of the copied tool file. */
  readonly entryPath: string;
  /** Absolute path of the central manifest file. */
  readonly manifestPath: string;
  readonly warnings: readonly ParseWarning[];
}

export type ToolImportErrorCode =
  | 'unsupported-extension'
  | 'invalid-identifier'
  | 'invalid-shape'
  | 'syntax-error'
  | 'imports-not-allowed'
  | 'namespace-collision'
  | 'tool-exists'
  | 'invalid-manifest';

/** Raised when a tool file cannot be imported. Names the source path. */
export class ToolImportError extends Error {
  override readonly name = 'ToolImportError';
  readonly code: ToolImportErrorCode;
  readonly sourcePath: string;

  constructor(code: ToolImportErrorCode, sourcePath: string, message: string) {
    super(`Cannot import ${sourcePath}: ${message}`);
    this.code = code;
    this.sourcePath = sourcePath;
  }
}

// Loose for the same forward-compatibility reason as the entry schema below:
// unknown permission keys on existing entries are preserved, not stripped.
const permissionsSchema = z.looseObject({
  network: z.boolean(),
  filesystem: z.boolean(),
  env: z.array(z.string()),
});

// Loose: unknown keys on existing entries (e.g. fields written by a newer
// ToolBox component) are preserved, not silently dropped when the manifest is
// rewritten during an unrelated import.
const toolManifestSchema = z.looseObject({
  name: z.string(),
  namespace: z.string(),
  exposedName: z.string(),
  title: z.string(),
  description: z.string(),
  entry: z.string(),
  runtime: z.literal('node'),
  enabled: z.boolean(),
  timeoutMs: z.number(),
  permissions: permissionsSchema,
});

const manifestFileSchema = z.array(toolManifestSchema);

/** Reads and validates the central manifest, returning [] when absent. */
async function readManifest(manifestPath: string, sourcePath: string): Promise<ToolManifest[]> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolImportError(
      'invalid-manifest',
      sourcePath,
      `the existing manifest at ${manifestPath} is not valid JSON`,
    );
  }

  const result = manifestFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ToolImportError(
      'invalid-manifest',
      sourcePath,
      `the existing manifest at ${manifestPath} does not match the expected schema`,
    );
  }
  return result.data;
}

export async function importTool(
  sourcePath: string,
  options: ImportToolOptions,
): Promise<ImportedTool> {
  const extension = path.extname(sourcePath);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new ToolImportError(
      'unsupported-extension',
      sourcePath,
      `unsupported file extension "${extension}"; expected .ts or .js`,
    );
  }

  const source = await fs.readFile(sourcePath, 'utf8');

  // parseToolMetadata throws ToolMetadataParseError for metadata problems; let
  // that propagate unwrapped so its line-anchored detail survives.
  const metadata = parseToolMetadata(source, sourcePath);

  if (metadata.syntaxErrors.length > 0) {
    const first = metadata.syntaxErrors[0];
    const where = first?.line !== undefined ? ` (line ${first.line})` : '';
    throw new ToolImportError(
      'syntax-error',
      sourcePath,
      `the tool file has a syntax error${where}: ${first?.message ?? 'unknown'}`,
    );
  }

  // Pure custom tools allow no runtime imports: only the entry file is stored, and a
  // pure tool keeps the execution sandbox enforceable. Erased type-only imports are
  // already excluded by the parser, so they are permitted.
  const runtimeImports = [
    ...metadata.relativeImports.map((specifier) => `relative import '${specifier}'`),
    ...metadata.bareImports.map((specifier) => `bare import '${specifier}'`),
    ...metadata.dynamicImports.map((issue) =>
      issue.line !== undefined ? `dynamic import (line ${issue.line})` : 'dynamic import',
    ),
  ];
  if (runtimeImports.length > 0) {
    throw new ToolImportError(
      'imports-not-allowed',
      sourcePath,
      `custom tools must be self-contained with no runtime imports; found: ${runtimeImports.join(', ')}`,
    );
  }

  const separator = options.separator ?? DEFAULT_SEPARATOR;

  // The namespace shares the upstream server-name rules: it is the prefix of the
  // exposed name, so it must obey the same charset and must not contain the
  // namespace separator. Otherwise `namespace "github__foo"` + `name "bar"`
  // would expose `github__foo__bar`, ambiguous with proxied `github` tool
  // `foo__bar` and able to bypass the server-name collision check below.
  if (!ServerNameSchema.safeParse(metadata.namespace).success) {
    throw new ToolImportError(
      'invalid-identifier',
      sourcePath,
      `@toolbox-tool namespace "${metadata.namespace}" must be alphanumeric with "-" or "_" and must not contain the "__" separator`,
    );
  }
  // ServerNameSchema only knows the default `__` separator; reject a custom one
  // too so the exposed name stays unambiguous under any configured separator.
  if (separator !== DEFAULT_SEPARATOR && metadata.namespace.includes(separator)) {
    throw new ToolImportError(
      'invalid-identifier',
      sourcePath,
      `@toolbox-tool namespace "${metadata.namespace}" must not contain the "${separator}" namespace separator`,
    );
  }
  if (!IDENTIFIER.test(metadata.name)) {
    throw new ToolImportError(
      'invalid-identifier',
      sourcePath,
      `@toolbox-tool name "${metadata.name}" must contain only letters, digits, "-", and "_"`,
    );
  }

  const shapeIssues: string[] = [];
  if (!metadata.hasDefaultFunctionExport) {
    shapeIssues.push('a default-exported function handler');
  }
  if (!metadata.hasInputSchema) {
    shapeIssues.push('an exported `inputSchema`');
  }
  if (shapeIssues.length > 0) {
    throw new ToolImportError(
      'invalid-shape',
      sourcePath,
      `tool file must export ${shapeIssues.join(' and ')}`,
    );
  }

  const exposedName = `${metadata.namespace}${separator}${metadata.name}`;

  if (options.serverNames?.includes(metadata.namespace)) {
    throw new ToolImportError(
      'namespace-collision',
      sourcePath,
      `namespace "${metadata.namespace}" collides with a configured upstream server name`,
    );
  }

  const toolsDir = path.join(options.configDir, TOOLS_DIR);
  const manifestPath = path.join(toolsDir, MANIFEST_FILENAME);
  const manifest = await readManifest(manifestPath, sourcePath);

  // Identity is namespace + name, not exposedName: the separator is configurable
  // and the stored file path (`tools/<namespace>/<name>.<ext>`) ignores it, so a
  // different separator must not slip past as a "new" tool.
  const existingIndex = manifest.findIndex(
    (entry) => entry.namespace === metadata.namespace && entry.name === metadata.name,
  );
  if (existingIndex !== -1 && options.force !== true) {
    throw new ToolImportError(
      'tool-exists',
      sourcePath,
      `a custom tool "${metadata.namespace}/${metadata.name}" already exists; pass force to overwrite it`,
    );
  }

  const entry = `${TOOLS_DIR}/${metadata.namespace}/${metadata.name}${extension}`;
  const entryPath = path.join(options.configDir, entry);

  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.writeFile(entryPath, source, 'utf8');

  // Stored `.js` tools live under tools/ with no package.json of their own, so Node would
  // load them as CommonJS and reject ESM `export` syntax. A type:module marker in tools/
  // makes every stored `.js` tool load as ESM (matching how they are parsed at import).
  const toolsPackageJsonPath = path.join(toolsDir, 'package.json');
  await fs.writeFile(
    toolsPackageJsonPath,
    `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    'utf8',
  );

  const entryManifest: ToolManifest = {
    name: metadata.name,
    namespace: metadata.namespace,
    exposedName,
    title: metadata.title,
    description: metadata.description,
    entry,
    runtime: 'node',
    enabled: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    permissions: { network: false, filesystem: false, env: [] },
  };

  const nextManifest =
    existingIndex === -1
      ? [...manifest, entryManifest]
      : manifest.map((entry, index) => (index === existingIndex ? entryManifest : entry));

  await fs.writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');

  return { manifest: entryManifest, entryPath, manifestPath, warnings: metadata.warnings };
}
