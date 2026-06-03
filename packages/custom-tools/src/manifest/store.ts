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

export type ToolManifestErrorCode = 'invalid-manifest' | 'tool-not-found' | 'source-missing';

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

/** Path segment charset for a namespace / name — matches the importer's rules. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Extensions a stored tool source may use (matches the importer). */
const STORED_EXTENSIONS = new Set(['.ts', '.js']);

/**
 * Resolves a tool's source file to an absolute path, accepting only the exact
 * storage convention the importer writes: `tools/<namespace>/<name>.<ext>` with
 * `<ext>` in `.ts` / `.js`, where `<namespace>` and `<name>` are the entry's own
 * fields and safe path segments. A hand-edited or corrupt manifest could
 * otherwise carry an `entry` that points at `tools/manifest.json`,
 * `tools/package.json`, another tool's source, or (via `..` / an absolute path)
 * outside `tools/` entirely — letting a read (`inspect`) or delete (`remove`)
 * touch the wrong file. Throws `ToolManifestError('invalid-manifest')` when the
 * entry does not match its record's canonical path.
 */
export function resolveToolEntryPath(configDir: string, manifest: ToolManifest): string {
  const { namespace, name, entry } = manifest;
  const ext = path.posix.extname(entry);
  if (!SAFE_SEGMENT.test(namespace) || !SAFE_SEGMENT.test(name) || !STORED_EXTENSIONS.has(ext)) {
    throw new ToolManifestError(
      'invalid-manifest',
      `tool entry for "${namespace}/${name}" is not a valid stored tool path`,
    );
  }
  const expected = `${TOOLS_DIR}/${namespace}/${name}${ext}`;
  if (entry !== expected) {
    throw new ToolManifestError(
      'invalid-manifest',
      `tool entry "${entry}" does not match its expected storage path "${expected}"`,
    );
  }
  return path.join(configDir, TOOLS_DIR, namespace, `${name}${ext}`);
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
 *
 * Enabling validates the entry against the storage convention (the same check
 * `inspect` / `remove` apply) and confirms the source file is present and
 * readable, so a tampered or dangling entry cannot be marked enabled for a later
 * exposure/call path to act on. Disabling skips both checks: turning a tool off
 * is the safe direction and must always be possible, even for an entry that is
 * already malformed or whose source is gone.
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
  if (enabled) {
    // Throws ToolManifestError('invalid-manifest') for a tampered entry path.
    const entryPath = resolveToolEntryPath(configDir, current);
    try {
      await fs.access(entryPath);
    } catch {
      throw new ToolManifestError(
        'source-missing',
        `cannot enable "${exposedName}": its source file is missing or unreadable at ${entryPath}`,
      );
    }
  }
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
  /** False when the source file was already gone or could not be deleted. */
  readonly sourceRemoved: boolean;
  /**
   * The reason the source file could not be deleted, for a failure other than
   * "already gone". Present only when `sourceRemoved` is false for that reason;
   * the manifest entry is dropped regardless, so the leftover is a benign orphan.
   */
  readonly sourceError?: string;
}

/**
 * Removes a custom tool: drops its manifest entry, then deletes its source file.
 * Throws `ToolManifestError('tool-not-found')` when no tool has the exposed name.
 *
 * The manifest is written before the file is deleted so a delete failure can
 * never leave a manifest entry pointing at a missing source (an actively broken,
 * exposable tool). A delete failure — the file already gone, or an unexpected
 * error like a permission/EISDIR — is therefore non-fatal: removal as a registry
 * operation has already succeeded, and the worst case is a benign orphan file
 * under `tools/` that nothing references. The reason is reported via
 * `sourceRemoved` / `sourceError` rather than thrown, so the caller is never
 * left unable to retry a removal whose record is already gone.
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
  // Only ever delete this record's own canonical tools/<ns>/<name>.<ext> path;
  // a tampered entry pointing elsewhere is rejected, not followed.
  const entryPath = resolveToolEntryPath(configDir, target);

  const next = entries.filter((_, i) => i !== index);
  await writeToolManifest(configDir, next);

  try {
    await fs.rm(entryPath);
    return { manifest: target, entryPath, sourceRemoved: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { manifest: target, entryPath, sourceRemoved: false };
    }
    return {
      manifest: target,
      entryPath,
      sourceRemoved: false,
      sourceError: (error as Error).message,
    };
  }
}
