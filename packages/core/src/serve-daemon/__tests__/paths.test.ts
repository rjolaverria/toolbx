import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveServeDaemonPaths, serveDaemonPathsForConfig } from '../paths.js';

describe('resolveServeDaemonPaths', () => {
  it('honors TOOLBOX_CONFIG and places both files next to it', () => {
    const result = resolveServeDaemonPaths({
      env: { TOOLBOX_CONFIG: '/custom/path/config.json' },
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(result.statePath).toBe(path.resolve('/custom/path/serve-state.json'));
    expect(result.logPath).toBe(path.resolve('/custom/path/serve.log'));
  });

  it('honors XDG_CONFIG_HOME on posix', () => {
    const result = resolveServeDaemonPaths({
      env: { XDG_CONFIG_HOME: '/xdg' },
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(result.statePath).toBe(path.join('/xdg', 'toolbox', 'serve-state.json'));
    expect(result.logPath).toBe(path.join('/xdg', 'toolbox', 'serve.log'));
  });

  it('falls back to ~/.config/toolbox/ on posix', () => {
    const result = resolveServeDaemonPaths({
      env: {},
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(result.statePath).toBe(path.join('/home/u', '.config', 'toolbox', 'serve-state.json'));
    expect(result.logPath).toBe(path.join('/home/u', '.config', 'toolbox', 'serve.log'));
  });

  it('uses %APPDATA%\\ToolBox\\ on win32 when APPDATA is set', () => {
    const result = resolveServeDaemonPaths({
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      platform: 'win32',
      homedir: () => 'C:\\Users\\u',
    });
    expect(result.statePath).toBe(
      path.join('C:\\Users\\u\\AppData\\Roaming', 'ToolBox', 'serve-state.json'),
    );
    expect(result.logPath).toBe(
      path.join('C:\\Users\\u\\AppData\\Roaming', 'ToolBox', 'serve.log'),
    );
  });
});

describe('serveDaemonPathsForConfig', () => {
  it('drops both files next to a literal config path', () => {
    const result = serveDaemonPathsForConfig('/some/where/config.json');
    expect(result.statePath).toBe(path.join('/some/where', 'serve-state.json'));
    expect(result.logPath).toBe(path.join('/some/where', 'serve.log'));
  });
});
