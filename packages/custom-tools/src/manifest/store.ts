/**
 * Read and mutate the central custom-tool manifest (SPECS §6.3).
 *
 * The importer (P3-02) owns writing new entries; this module owns the lookup,
 * enable/disable, and removal operations the `tlbx tool` CLI (P3-04) and the
 * gateway exposure (P3-05) need. It reuses the importer's manifest schema and
 * path conventions so there is a single source of truth for the on-disk shape.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteFile } from './atomic-write.js';
import { manifestFileSchema, MANIFEST_FILENAME, TOOLS_DIR, type ToolManifest } from './import.js';

export type ToolManifestErrorCode = 'invalid-manifest' | 'tool-not-found';

/** Raised when the manifest cannot be read or a named tool is absent. */
export class ToolManifestError extends Error {
  override readonly name = 'ToolManifestError';
  readonly code: ToolManifestErrorCode;

  constructor(code: ToolManifestErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Absolute path of the tools directory inside a ToolBox config directory. */
export function toolsDirPath(configDir: string): string {
  return path.join(configDir, TOOLS_DIR);
}

/** Absolute path of the central manifest file inside a ToolBox config directory. */
export function toolsManifestPath(configDir: string): string {
  return path.join(toolsDirPath(configDir), MANIFEST_FILENAME);
}

/**
 * Resolves a manifest `entry` to an absolute path, refusing any value that
 * escapes the tools directory. The importer only ever writes
 * `tools/<namespace>/<name>.<ext>`, but a hand-edited or corrupt manifest could
 * carry an absolute path or `..` traversal; resolving it blindly would let a
 * read (`inspect`) or delete (`remove`) touch files outside `tools/`. Throws
 * `ToolManifestError('invalid-manifest')` when the entry does not land strictly
 * inside `toolsDirPath(configDir)`.
 */
export function resolveToolEntryPath(configDir: string, entry: string): string {
  const toolsDir = toolsDirPath(configDir);
  const resolved = path.resolve(configDir, entry);
  const relative = path.relative(toolsDir, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ToolManifestError(
      'invalid-manifest',
      `tool entry "${entry}" resolves outside the tools directory`,
    );
  }
  return resolved;
}

/**
 * Reads and validates the central manifest, returning `[]` when no tools have
 * been imported yet. Throws `ToolManifestError` when the file exists but is not
 * valid JSON or does not match the manifest schema.
 */
export async function readToolManifest(configDir: string): Promise<ToolManifest[]> {
  const manifestPath = toolsManifestPath(configDir);
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
    throw new ToolManifestError(
      'invalid-manifest',
      `the tool manifest at ${manifestPath} is not valid JSON`,
    );
  }

  const result = manifestFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ToolManifestError(
      'invalid-manifest',
      `the tool manifest at ${manifestPath} does not match the expected schema`,
    );
  }
  return result.data;
}

/** Persists the manifest entries atomically, pretty-printed with a trailing newline. */
export async function writeToolManifest(
  configDir: string,
  entries: readonly ToolManifest[],
): Promise<void> {
  await atomicWriteFile(toolsManifestPath(configDir), `${JSON.stringify(entries, null, 2)}\n`);
}

/** Finds a manifest entry by its exposed (namespaced) name. */
export function findToolByExposedName(
  entries: readonly ToolManifest[],
  exposedName: string,
): ToolManifest | undefined {
  return entries.find((entry) => entry.exposedName === exposedName);
}

export interface SetEnabledResult {
  readonly manifest: ToolManifest;
  /** False when the tool was already in the requested state. */
  readonly changed: boolean;
}

/**
 * Toggles a custom tool's `enabled` flag and persists the manifest. Throws
 * `ToolManifestError('tool-not-found')` when no tool has the exposed name.
 */
export async function setToolEnabled(
  configDir: string,
  exposedName: string,
  enabled: boolean,
): Promise<SetEnabledResult> {
  const entries = await readToolManifest(configDir);
  const index = entries.findIndex((entry) => entry.exposedName === exposedName);
  if (index === -1) {
    throw new ToolManifestError('tool-not-found', `no custom tool named "${exposedName}"`);
  }
  const current = entries[index] as ToolManifest;
  if (current.enabled === enabled) {
    return { manifest: current, changed: false };
  }
  const updated: ToolManifest = { ...current, enabled };
  const next = entries.map((entry, i) => (i === index ? updated : entry));
  await writeToolManifest(configDir, next);
  return { manifest: updated, changed: true };
}

export interface RemoveToolResult {
  readonly manifest: ToolManifest;
  /** Absolute path of the source file that was removed. */
  readonly entryPath: string;
  /** False when the source file was already gone. */
  readonly sourceRemoved: boolean;
}

/**
 * Removes a custom tool: deletes its source file and drops its manifest entry.
 * Throws `ToolManifestError('tool-not-found')` when no tool has the exposed
 * name. A missing source file is not an error — the manifest entry is still
 * dropped so the manifest cannot keep a dangling reference.
 */
export async function removeTool(
  configDir: string,
  exposedName: string,
): Promise<RemoveToolResult> {
  const entries = await readToolManifest(configDir);
  const index = entries.findIndex((entry) => entry.exposedName === exposedName);
  if (index === -1) {
    throw new ToolManifestError('tool-not-found', `no custom tool named "${exposedName}"`);
  }
  const target = entries[index] as ToolManifest;
  // Refuse to delete anything the manifest points outside tools/ (tampered entry).
  const entryPath = resolveToolEntryPath(configDir, target.entry);

  let sourceRemoved = true;
  try {
    await fs.rm(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      sourceRemoved = false;
    } else {
      throw error;
    }
  }

  const next = entries.filter((_, i) => i !== index);
  await writeToolManifest(configDir, next);
  return { manifest: target, entryPath, sourceRemoved };
}
