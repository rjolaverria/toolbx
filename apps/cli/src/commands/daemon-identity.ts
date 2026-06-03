import * as path from 'node:path';

import { computeConfigIdentity, type ToolBoxConfig } from '@toolbox/core';
import { readToolManifest } from '@toolbox/custom-tools';

/**
 * Reads the custom-tool manifest for daemon-identity purposes, treating any
 * read/parse failure as "no custom tools". A corrupt manifest makes the gateway
 * expose no custom tools, so reporting `[]` keeps the published identity and the
 * reuse-check identity in agreement instead of one side throwing.
 */
export async function readManifestForIdentity(configDir: string): Promise<readonly unknown[]> {
  try {
    return await readToolManifest(configDir);
  } catch {
    return [];
  }
}

/**
 * Daemon identity over the config *and* the custom-tool manifest. Custom tools
 * live in `tools/manifest.json`, not `config.json`, but `tlbx tool
 * enable/disable/remove/import` change what the daemon should expose — so a
 * reused daemon must be treated as stale when the manifest drifts, exactly as it
 * already is for a config edit (P3-05).
 */
export async function computeDaemonIdentity(
  config: ToolBoxConfig,
  configPath: string,
): Promise<string> {
  const manifest = await readManifestForIdentity(path.dirname(configPath));
  return computeConfigIdentity(config, manifest);
}
