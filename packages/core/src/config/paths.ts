import { homedir as osHomedir } from 'node:os';
import * as path from 'node:path';

export interface ConfigPathEnv {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}

export type ConfigPathSource =
  | 'env-toolbox-config'
  | 'env-xdg-config-home'
  | 'env-appdata'
  | 'home-windows'
  | 'home-posix';

export interface ResolvedConfigPath {
  path: string;
  source: ConfigPathSource;
}

const TOOLBOX_DIR_POSIX = 'toolbox';
const TOOLBOX_DIR_WIN = 'ToolBox';
const CONFIG_FILENAME = 'config.json';

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function describeConfigPath(overrides: ConfigPathEnv = {}): ResolvedConfigPath {
  const env = overrides.env ?? process.env;
  const platform = overrides.platform ?? process.platform;
  const homedir = overrides.homedir ?? osHomedir;

  const explicit = env.TOOLBOX_CONFIG;
  if (nonEmpty(explicit)) {
    return { path: path.resolve(explicit), source: 'env-toolbox-config' };
  }

  const xdg = env.XDG_CONFIG_HOME;
  if (nonEmpty(xdg)) {
    return {
      path: path.join(xdg, TOOLBOX_DIR_POSIX, CONFIG_FILENAME),
      source: 'env-xdg-config-home',
    };
  }

  if (platform === 'win32') {
    const appdata = env.APPDATA;
    if (nonEmpty(appdata)) {
      return {
        path: path.join(appdata, TOOLBOX_DIR_WIN, CONFIG_FILENAME),
        source: 'env-appdata',
      };
    }
    return {
      path: path.join(homedir(), 'AppData', 'Roaming', TOOLBOX_DIR_WIN, CONFIG_FILENAME),
      source: 'home-windows',
    };
  }

  return {
    path: path.join(homedir(), '.config', TOOLBOX_DIR_POSIX, CONFIG_FILENAME),
    source: 'home-posix',
  };
}

export function resolveConfigPath(overrides: ConfigPathEnv = {}): string {
  return describeConfigPath(overrides).path;
}

export function getDefaultConfigPath(): string {
  return resolveConfigPath();
}
