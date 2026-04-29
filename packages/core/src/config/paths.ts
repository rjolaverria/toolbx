import { homedir as osHomedir } from 'node:os';
import * as path from 'node:path';

export interface ConfigPathEnv {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}

const TOOLBOX_DIR_POSIX = 'toolbox';
const TOOLBOX_DIR_WIN = 'Toolbox';
const CONFIG_FILENAME = 'config.json';

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function resolveConfigPath(overrides: ConfigPathEnv = {}): string {
  const env = overrides.env ?? process.env;
  const platform = overrides.platform ?? process.platform;
  const homedir = overrides.homedir ?? osHomedir;

  const explicit = env.TOOLBOX_CONFIG;
  if (nonEmpty(explicit)) {
    return path.resolve(explicit);
  }

  const xdg = env.XDG_CONFIG_HOME;
  if (nonEmpty(xdg)) {
    return path.join(xdg, TOOLBOX_DIR_POSIX, CONFIG_FILENAME);
  }

  if (platform === 'win32') {
    const appdata = env.APPDATA;
    if (nonEmpty(appdata)) {
      return path.join(appdata, TOOLBOX_DIR_WIN, CONFIG_FILENAME);
    }
    return path.join(homedir(), 'AppData', 'Roaming', TOOLBOX_DIR_WIN, CONFIG_FILENAME);
  }

  return path.join(homedir(), '.config', TOOLBOX_DIR_POSIX, CONFIG_FILENAME);
}

export function getDefaultConfigPath(): string {
  return resolveConfigPath();
}
