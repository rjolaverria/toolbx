import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { resolveConfigPath, type ConfigPathEnv } from '../config/paths.js';

const SERVE_FILE_PREFIX = 'serve';

export interface ServeDaemonPaths {
  readonly statePath: string;
  readonly logPath: string;
}

/**
 * Derives the daemon state/log paths for a fully resolved config path. Both
 * files live next to the config (mirroring `resolveToolCachePath`) but their
 * names are keyed by a hash of the *full resolved config path*, not just the
 * directory. Two configs that share a directory (`/dir/a.json`, `/dir/b.json`)
 * therefore get distinct daemon state, so reuse / stop / collision decisions
 * are made per resolved config and a daemon for one config is never mistaken
 * for another.
 */
function daemonPathsForResolvedConfig(absConfigPath: string): ServeDaemonPaths {
  const dir = path.dirname(absConfigPath);
  const key = createHash('sha256').update(absConfigPath).digest('hex').slice(0, 12);
  return {
    statePath: path.join(dir, `${SERVE_FILE_PREFIX}-${key}.state.json`),
    logPath: path.join(dir, `${SERVE_FILE_PREFIX}-${key}.log`),
  };
}

/**
 * Resolves the daemon paths for the ambient config (honouring
 * `XDG_CONFIG_HOME` / `TOOLBX_CONFIG`). Equivalent to
 * `serveDaemonPathsForConfig(resolveConfigPath(...))`.
 */
export function resolveServeDaemonPaths(overrides: ConfigPathEnv = {}): ServeDaemonPaths {
  return daemonPathsForResolvedConfig(path.resolve(resolveConfigPath(overrides)));
}

/**
 * Same as `resolveServeDaemonPaths` but anchored to an explicit config file
 * path. CLI commands that already accept `--config` use this so the daemon
 * artifacts follow the config the user pointed them at. The path is resolved
 * to an absolute path first so the same logical config always maps to the same
 * daemon files regardless of how it was spelled.
 */
export function serveDaemonPathsForConfig(configPath: string): ServeDaemonPaths {
  return daemonPathsForResolvedConfig(path.resolve(configPath));
}
