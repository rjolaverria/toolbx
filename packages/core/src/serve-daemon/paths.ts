import * as path from 'node:path';

import { resolveConfigPath, type ConfigPathEnv } from '../config/paths.js';

const SERVE_STATE_FILENAME = 'serve-state.json';
const SERVE_LOG_FILENAME = 'serve.log';

export interface ServeDaemonPaths {
  readonly statePath: string;
  readonly logPath: string;
}

/**
 * Both files live next to the resolved config (mirroring `resolveToolCachePath`).
 * `XDG_CONFIG_HOME` / `TOOLBOX_CONFIG` overrides are honoured automatically —
 * when `TOOLBOX_CONFIG` points at a specific file, the daemon files land in
 * that file's directory.
 */
export function resolveServeDaemonPaths(overrides: ConfigPathEnv = {}): ServeDaemonPaths {
  const configPath = resolveConfigPath(overrides);
  const dir = path.dirname(configPath);
  return {
    statePath: path.join(dir, SERVE_STATE_FILENAME),
    logPath: path.join(dir, SERVE_LOG_FILENAME),
  };
}

/**
 * Same as `resolveServeDaemonPaths` but anchored to an explicit config file
 * path. CLI commands that already accept `--config` use this so the daemon
 * artifacts follow the config the user pointed them at, not the ambient
 * environment.
 */
export function serveDaemonPathsForConfig(configPath: string): ServeDaemonPaths {
  const dir = path.dirname(configPath);
  return {
    statePath: path.join(dir, SERVE_STATE_FILENAME),
    logPath: path.join(dir, SERVE_LOG_FILENAME),
  };
}
