import * as path from 'node:path';

import { computeConfigIdentity, type ToolbxConfig } from '@toolbx/core';
import { digestToolSources, readToolManifest } from '@toolbx/custom-tools';

/**
 * Reads the custom-tool manifest for daemon-identity purposes and annotates each
 * enabled entry with a digest of its source file. Treats any read/parse failure
 * as "no custom tools": a corrupt manifest makes the gateway expose none, so
 * reporting `[]` keeps the published identity and the reuse-check identity in
 * agreement instead of one side throwing. This mirrors exactly what the gateway
 * runtime publishes (`digestToolSources` over the loaded manifest), so the two
 * identities match for the same on-disk state.
 */
export async function readManifestForIdentity(configDir: string): Promise<readonly unknown[]> {
  try {
    return await digestToolSources(configDir, await readToolManifest(configDir));
  } catch {
    return [];
  }
}

/**
 * Daemon identity over the config *and* the custom-tool manifest (including each
 * enabled tool's source digest). Custom tools live in `tools/manifest.json`, not
 * `config.json`, but `tlbx tool enable/disable/remove/import` change what the
 * daemon should expose — and editing a tool's source changes its digest — so a
 * reused daemon must be treated as stale when any of those drift, exactly as it
 * already is for a config edit (P3-05).
 */
export async function computeDaemonIdentity(
  config: ToolbxConfig,
  configPath: string,
): Promise<string> {
  const manifest = await readManifestForIdentity(path.dirname(configPath));
  return computeConfigIdentity(config, manifest);
}
