import * as fs from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig } from '@toolbx/core';

import {
  InvalidConfigPathError,
  parseDottedPath,
  parseJsonValue,
  runConfigSet,
  setAtPath,
} from '../config-set.js';

import { makeHarness, makeTempConfig, type ConfigHarness } from './harness.js';

const harnesses: ConfigHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) {
      await h.cleanup();
    }
  }
});

describe('parseDottedPath', () => {
  it('splits on dots', () => {
    expect(parseDottedPath('progressiveDisclosure.enabled')).toEqual([
      'progressiveDisclosure',
      'enabled',
    ]);
  });

  it('rejects empty input', () => {
    expect(() => parseDottedPath('')).toThrow(InvalidConfigPathError);
  });

  it('rejects empty segments', () => {
    expect(() => parseDottedPath('a..b')).toThrow(InvalidConfigPathError);
    expect(() => parseDottedPath('.a')).toThrow(InvalidConfigPathError);
    expect(() => parseDottedPath('a.')).toThrow(InvalidConfigPathError);
  });

  it('rejects prototype-pollution segment names', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      expect(() => parseDottedPath(reserved)).toThrow(InvalidConfigPathError);
      expect(() => parseDottedPath(`a.${reserved}.b`)).toThrow(InvalidConfigPathError);
    }
  });
});

describe('parseJsonValue', () => {
  it('parses booleans, strings, numbers, arrays, and objects', () => {
    expect(parseJsonValue('true')).toBe(true);
    expect(parseJsonValue('false')).toBe(false);
    expect(parseJsonValue('"hello"')).toBe('hello');
    expect(parseJsonValue('5')).toBe(5);
    expect(parseJsonValue('[1,2]')).toEqual([1, 2]);
    expect(parseJsonValue('{"a":1}')).toEqual({ a: 1 });
  });

  it('rejects non-JSON values', () => {
    expect(() => parseJsonValue('not json')).toThrow(InvalidConfigPathError);
  });
});

describe('setAtPath', () => {
  it('sets a leaf value without mutating the original object', () => {
    const root = { a: { b: 1 } };
    const out = setAtPath(root, ['a', 'b'], 2);
    expect(out).toEqual({ a: { b: 2 } });
    expect(root).toEqual({ a: { b: 1 } });
  });

  it('rejects traversal through a non-object intermediate', () => {
    expect(() => setAtPath({ a: 1 }, ['a', 'b'], 2)).toThrow(InvalidConfigPathError);
  });

  it('replaces a top-level value when the path has a single segment', () => {
    const out = setAtPath({ a: { b: 1 } }, ['a'], { b: 2, c: 3 });
    expect(out).toEqual({ a: { b: 2, c: 3 } });
  });
});

describe('runConfigSet', () => {
  it('persists progressiveDisclosure.enabled true', async () => {
    const cfg = await makeTempConfig({
      ...DEFAULT_CONFIG,
      progressiveDisclosure: { ...DEFAULT_CONFIG.progressiveDisclosure, enabled: false },
    });
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runConfigSet('progressiveDisclosure.enabled', 'true', h.deps, {});

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.progressiveDisclosure.enabled).toBe(true);
  });

  it('persists progressiveDisclosure.enabled false', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runConfigSet('progressiveDisclosure.enabled', 'false', h.deps, {});

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.progressiveDisclosure.enabled).toBe(false);
  });

  it('rejects an unknown path through a non-object intermediate', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    const before = await fs.readFile(cfg.target, 'utf8');
    const h = makeHarness(cfg.target);

    const code = await runConfigSet('version.bogus', '1', h.deps, {});

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('not an object');
    const after = await fs.readFile(cfg.target, 'utf8');
    expect(after).toBe(before);
  });

  it('rejects a value that breaks schema validation and never writes', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    const before = await fs.readFile(cfg.target, 'utf8');
    const h = makeHarness(cfg.target);

    const code = await runConfigSet('progressiveDisclosure.enabled', '"not-a-bool"', h.deps, {});

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('progressiveDisclosure');
    const after = await fs.readFile(cfg.target, 'utf8');
    expect(after).toBe(before);
  });

  it('rejects adding an unknown leaf key (strict schema)', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    const before = await fs.readFile(cfg.target, 'utf8');
    const h = makeHarness(cfg.target);

    const code = await runConfigSet('progressiveDisclosure.bogus', 'true', h.deps, {});

    expect(code).toBe(1);
    const after = await fs.readFile(cfg.target, 'utf8');
    expect(after).toBe(before);
  });

  it('rejects an empty path', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runConfigSet('', 'true', h.deps, {});

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('must not be empty');
  });

  it('rejects a non-JSON value', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const code = await runConfigSet('progressiveDisclosure.enabled', 'not-json', h.deps, {});

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('not valid JSON');
  });

  it('reports a missing config file', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    await fs.unlink(cfg.target);
    const h = makeHarness(cfg.target);

    const code = await runConfigSet('progressiveDisclosure.enabled', 'true', h.deps, {});

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('No Toolbx config found');
  });

  it('reports duplicate JSON keys cleanly without an uncaught exception', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    // Hand-craft a config with duplicate JSON keys at the root.
    await fs.writeFile(
      cfg.target,
      `{
        "version": 1,
        "version": 1,
        "server": ${JSON.stringify(DEFAULT_CONFIG.server)},
        "progressiveDisclosure": ${JSON.stringify(DEFAULT_CONFIG.progressiveDisclosure)},
        "namespacing": ${JSON.stringify(DEFAULT_CONFIG.namespacing)},
        "servers": {},
        "tools": {}
      }`,
      'utf8',
    );
    const h = makeHarness(cfg.target);

    const code = await runConfigSet('progressiveDisclosure.enabled', 'true', h.deps, {});

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('Duplicate JSON');
  });

  it('rejects setting a forbidden segment name', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    const before = await fs.readFile(cfg.target, 'utf8');
    const h = makeHarness(cfg.target);

    const code = await runConfigSet('__proto__.polluted', 'true', h.deps, {});

    expect(code).toBe(1);
    expect(h.stderr.value).toContain('reserved segment');
    const after = await fs.readFile(cfg.target, 'utf8');
    expect(after).toBe(before);
  });

  it('replaces an entire subtree when given a JSON object', async () => {
    const cfg = await makeTempConfig(DEFAULT_CONFIG);
    harnesses.push(cfg);
    const h = makeHarness(cfg.target);

    const replacement = {
      enabled: true,
      mode: 'global',
      bootstrapTools: false,
      autoRevealExactServerMatches: false,
      maxSearchResults: 5,
    };
    const code = await runConfigSet(
      'progressiveDisclosure',
      JSON.stringify(replacement),
      h.deps,
      {},
    );

    expect(code).toBe(0);
    const reloaded = await loadConfig(cfg.target);
    expect(reloaded.progressiveDisclosure).toEqual(replacement);
  });
});
