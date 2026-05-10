import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { describeConfigPath, resolveConfigPath } from '../paths.js';

describe('resolveConfigPath', () => {
  it('honors TOOLBOX_CONFIG over every other rule', () => {
    const result = resolveConfigPath({
      env: {
        TOOLBOX_CONFIG: '/custom/path/config.json',
        XDG_CONFIG_HOME: '/should/be/ignored',
        APPDATA: 'C:\\should\\be\\ignored',
      },
      platform: 'win32',
      homedir: () => '/home/should/be/ignored',
    });
    expect(result).toBe(path.resolve('/custom/path/config.json'));
  });

  it('honors XDG_CONFIG_HOME when TOOLBOX_CONFIG is not set', () => {
    const result = resolveConfigPath({
      env: { XDG_CONFIG_HOME: '/xdg' },
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(result).toBe(path.join('/xdg', 'toolbox', 'config.json'));
  });

  it('falls back to ~/.config/toolbox/config.json on linux', () => {
    const result = resolveConfigPath({
      env: {},
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(result).toBe(path.join('/home/u', '.config', 'toolbox', 'config.json'));
  });

  it('falls back to ~/.config/toolbox/config.json on darwin', () => {
    const result = resolveConfigPath({
      env: {},
      platform: 'darwin',
      homedir: () => '/Users/u',
    });
    expect(result).toBe(path.join('/Users/u', '.config', 'toolbox', 'config.json'));
  });

  it('uses %APPDATA%\\ToolBox\\config.json on win32 when APPDATA is set', () => {
    const result = resolveConfigPath({
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      platform: 'win32',
      homedir: () => 'C:\\Users\\u',
    });
    expect(result).toBe(path.join('C:\\Users\\u\\AppData\\Roaming', 'ToolBox', 'config.json'));
  });

  it('falls back to <home>/AppData/Roaming/ToolBox/config.json on win32 when APPDATA is unset', () => {
    const result = resolveConfigPath({
      env: {},
      platform: 'win32',
      homedir: () => 'C:\\Users\\u',
    });
    expect(result).toBe(path.join('C:\\Users\\u', 'AppData', 'Roaming', 'ToolBox', 'config.json'));
  });

  it('treats an empty TOOLBOX_CONFIG as unset', () => {
    const result = resolveConfigPath({
      env: { TOOLBOX_CONFIG: '', XDG_CONFIG_HOME: '/xdg' },
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(result).toBe(path.join('/xdg', 'toolbox', 'config.json'));
  });

  it('treats an empty XDG_CONFIG_HOME as unset', () => {
    const result = resolveConfigPath({
      env: { XDG_CONFIG_HOME: '' },
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(result).toBe(path.join('/home/u', '.config', 'toolbox', 'config.json'));
  });
});

describe('describeConfigPath', () => {
  it('reports `env-toolbox-config` when TOOLBOX_CONFIG wins', () => {
    const result = describeConfigPath({
      env: { TOOLBOX_CONFIG: '/x', XDG_CONFIG_HOME: '/y' },
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(result.source).toBe('env-toolbox-config');
    expect(result.path).toBe(path.resolve('/x'));
  });

  it('reports `env-xdg-config-home` when XDG_CONFIG_HOME wins', () => {
    const result = describeConfigPath({
      env: { XDG_CONFIG_HOME: '/xdg' },
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(result.source).toBe('env-xdg-config-home');
  });

  it('reports `env-appdata` on win32 with APPDATA set', () => {
    const result = describeConfigPath({
      env: { APPDATA: 'C:\\AppData' },
      platform: 'win32',
      homedir: () => 'C:\\Users\\u',
    });
    expect(result.source).toBe('env-appdata');
  });

  it('reports `home-windows` on win32 without APPDATA', () => {
    const result = describeConfigPath({
      env: {},
      platform: 'win32',
      homedir: () => 'C:\\Users\\u',
    });
    expect(result.source).toBe('home-windows');
  });

  it('reports `home-posix` on posix without env overrides', () => {
    const result = describeConfigPath({
      env: {},
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(result.source).toBe('home-posix');
  });
});
