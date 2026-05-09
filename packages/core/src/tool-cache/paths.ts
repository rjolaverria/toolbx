import * as path from 'node:path';

import { resolveConfigPath, type ConfigPathEnv } from '../config/paths.js';

const TOOL_CACHE_FILENAME = 'tools-cache.json';

/**
 * Tool cache lives next to the config file: `<config-dir>/tools-cache.json`.
 * It is a snapshot of the last successful upstream `tools/list` per server,
 * written by the gateway runtime. CLI commands that need to inspect the tool
 * inventory without spinning up the gateway (e.g. `tlbx tools list`) read it.
 *
 * The path tracks `resolveConfigPath`, so `XDG_CONFIG_HOME` and `TOOLBOX_CONFIG`
 * overrides are honoured automatically. When `TOOLBOX_CONFIG` points at a
 * specific file, the cache lives next to that file.
 */
export function resolveToolCachePath(overrides: ConfigPathEnv = {}): string {
  const configPath = resolveConfigPath(overrides);
  return path.join(path.dirname(configPath), TOOL_CACHE_FILENAME);
}
