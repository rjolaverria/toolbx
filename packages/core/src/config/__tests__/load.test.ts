import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DuplicateKeyError } from '../duplicate-keys.js';
import { ConfigLoadError, ConfigValidationError, loadConfig, parseConfig } from '../load.js';

const VALID_CONFIG_JSON = `{
  "version": 1,
  "server": {
    "stdio": { "enabled": true },
    "http": { "enabled": false, "host": "127.0.0.1", "port": 7331, "path": "/mcp" }
  },
  "progressiveDisclosure": {
    "enabled": false,
    "mode": "session",
    "bootstrapTools": true,
    "autoRevealExactServerMatches": false,
    "maxSearchResults": 20
  },
  "namespacing": {
    "format": "server__tool",
    "collisionStrategy": "error"
  },
  "servers": {}
}`;

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolbox-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

describe('parseConfig', () => {
  it('returns a typed ToolBoxConfig for valid input', () => {
    const config = parseConfig(VALID_CONFIG_JSON);
    expect(config.version).toBe(1);
    expect(config.namespacing.separator).toBe('__'); // default applied
    expect(config.servers).toEqual({});
  });

  it('throws DuplicateKeyError on a hand-crafted JSON with duplicate keys', () => {
    const json = `{
  "version": 1,
  "servers": {
    "jira": { "type": "http", "enabled": true, "url": "https://j" },
    "jira": { "type": "stdio", "enabled": true, "command": "x" }
  }
}`;
    expect(() => parseConfig(json)).toThrow(DuplicateKeyError);
  });

  it('throws ConfigLoadError on malformed JSON', () => {
    expect(() => parseConfig('{ not json')).toThrow(ConfigLoadError);
  });

  it('throws ConfigValidationError on schema-invalid input', () => {
    const json = JSON.stringify({
      version: 1,
      server: {
        stdio: { enabled: true },
        http: { enabled: true, host: '127.0.0.1', port: 'not-a-number', path: '/mcp' },
      },
      progressiveDisclosure: {
        enabled: true,
        mode: 'session',
        bootstrapTools: true,
        autoRevealExactServerMatches: true,
        maxSearchResults: 20,
      },
      namespacing: { format: 'server__tool', collisionStrategy: 'error' },
      servers: {},
    });
    expect(() => parseConfig(json, '/x/y/config.json')).toThrow(ConfigValidationError);
  });

  it('includes the source label in error messages', () => {
    try {
      parseConfig('{ broken', '/path/to/config.json');
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigLoadError);
      expect((error as ConfigLoadError).message).toContain('/path/to/config.json');
    }
  });
});

describe('loadConfig', () => {
  it('reads and parses a config file from disk', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, VALID_CONFIG_JSON, 'utf8');
    const config = await loadConfig(file);
    expect(config.version).toBe(1);
  });

  it('throws ConfigLoadError when the file does not exist', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'missing.json');
    await expect(loadConfig(file)).rejects.toBeInstanceOf(ConfigLoadError);
  });

  it('surfaces duplicate keys from disk-loaded files', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'config.json');
    const json = `{
  "version": 1,
  "server": {
    "stdio": { "enabled": true },
    "http": { "enabled": false, "host": "127.0.0.1", "port": 7331, "path": "/mcp" }
  },
  "progressiveDisclosure": {
    "enabled": false,
    "mode": "session",
    "bootstrapTools": true,
    "autoRevealExactServerMatches": false,
    "maxSearchResults": 20
  },
  "namespacing": { "format": "server__tool", "collisionStrategy": "error" },
  "servers": {
    "jira": { "type": "http", "enabled": true, "url": "https://a" },
    "jira": { "type": "http", "enabled": true, "url": "https://b" }
  }
}`;
    await fs.writeFile(file, json, 'utf8');
    await expect(loadConfig(file)).rejects.toBeInstanceOf(DuplicateKeyError);
  });
});
