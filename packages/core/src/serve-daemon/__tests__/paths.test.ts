import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveServeDaemonPaths, serveDaemonPathsForConfig } from '../paths.js';

const STATE_NAME = /^serve-[0-9a-f]{12}\.state\.json$/;
const LOG_NAME = /^serve-[0-9a-f]{12}\.log$/;

describe('resolveServeDaemonPaths', () => {
  it('honors TOOLBOX_CONFIG and places both files next to it', () => {
    const result = resolveServeDaemonPaths({
      env: { TOOLBOX_CONFIG: '/custom/path/config.json' },
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(path.dirname(result.statePath)).toBe(path.resolve('/custom/path'));
    expect(path.dirname(result.logPath)).toBe(path.resolve('/custom/path'));
    expect(path.basename(result.statePath)).toMatch(STATE_NAME);
    expect(path.basename(result.logPath)).toMatch(LOG_NAME);
  });

  it('honors XDG_CONFIG_HOME on posix', () => {
    const result = resolveServeDaemonPaths({
      env: { XDG_CONFIG_HOME: '/xdg' },
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(path.dirname(result.statePath)).toBe(path.join('/xdg', 'toolbox'));
    expect(path.basename(result.statePath)).toMatch(STATE_NAME);
  });

  it('falls back to ~/.config/toolbox/ on posix', () => {
    const result = resolveServeDaemonPaths({
      env: {},
      platform: 'linux',
      homedir: () => '/home/u',
    });
    expect(path.dirname(result.statePath)).toBe(path.join('/home/u', '.config', 'toolbox'));
    expect(path.basename(result.statePath)).toMatch(STATE_NAME);
  });

  it('uses %APPDATA%\\ToolBox\\ on win32 when APPDATA is set', () => {
    const result = resolveServeDaemonPaths({
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      platform: 'win32',
      homedir: () => 'C:\\Users\\u',
    });
    expect(result.statePath).toContain('ToolBox');
    expect(path.basename(result.statePath)).toMatch(STATE_NAME);
  });
});

describe('serveDaemonPathsForConfig', () => {
  it('drops both files next to a literal config path', () => {
    const result = serveDaemonPathsForConfig('/some/where/config.json');
    expect(path.dirname(result.statePath)).toBe('/some/where');
    expect(path.dirname(result.logPath)).toBe('/some/where');
    expect(path.basename(result.statePath)).toMatch(STATE_NAME);
    expect(path.basename(result.logPath)).toMatch(LOG_NAME);
  });

  it('gives two configs in the same directory distinct daemon files', () => {
    const a = serveDaemonPathsForConfig('/dir/a.json');
    const b = serveDaemonPathsForConfig('/dir/b.json');
    expect(a.statePath).not.toBe(b.statePath);
    expect(a.logPath).not.toBe(b.logPath);
    expect(path.dirname(a.statePath)).toBe('/dir');
    expect(path.dirname(b.statePath)).toBe('/dir');
  });

  it('is deterministic and independent of how the path is spelled', () => {
    const canonical = serveDaemonPathsForConfig('/dir/sub/config.json');
    const messy = serveDaemonPathsForConfig('/dir/sub/../sub/config.json');
    expect(messy.statePath).toBe(canonical.statePath);
    expect(messy.logPath).toBe(canonical.logPath);
  });

  it('matches resolveServeDaemonPaths for the same resolved config', () => {
    const viaEnv = resolveServeDaemonPaths({
      env: { TOOLBOX_CONFIG: '/custom/path/config.json' },
      platform: 'linux',
      homedir: () => '/home/u',
    });
    const viaPath = serveDaemonPathsForConfig('/custom/path/config.json');
    expect(viaPath.statePath).toBe(viaEnv.statePath);
    expect(viaPath.logPath).toBe(viaEnv.logPath);
  });
});
