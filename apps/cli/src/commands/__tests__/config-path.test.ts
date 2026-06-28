import { describe, expect, it } from 'vitest';

import type { ResolvedConfigPath } from '@toolbx/core';

import { describeSource, runConfigPath, type ConfigPathDeps } from '../config-path.js';

interface Harness {
  deps: ConfigPathDeps;
  stdout: { value: string };
}

function makeHarness(resolved: ResolvedConfigPath): Harness {
  const stdout = { value: '' };
  const deps: ConfigPathDeps = {
    describe: () => resolved,
    stdout: (msg) => {
      stdout.value += msg;
    },
  };
  return { deps, stdout };
}

describe('runConfigPath', () => {
  it('prints path and source description in human mode', () => {
    const h = makeHarness({ path: '/tmp/c.json', source: 'home-posix' });

    const code = runConfigPath({}, h.deps);

    expect(code).toBe(0);
    expect(h.stdout.value).toContain('/tmp/c.json');
    expect(h.stdout.value).toContain(describeSource('home-posix'));
  });

  it('emits machine-readable JSON with --json', () => {
    const h = makeHarness({ path: '/etc/c.json', source: 'env-toolbx-config' });

    const code = runConfigPath({ json: true }, h.deps);

    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(h.stdout.value);
    expect(parsed).toEqual({
      path: '/etc/c.json',
      source: 'env-toolbx-config',
      sourceDescription: describeSource('env-toolbx-config'),
    });
  });

  it('reports each precedence rule with a distinct description', () => {
    const sources = [
      'env-toolbx-config',
      'env-xdg-config-home',
      'env-appdata',
      'home-windows',
      'home-posix',
    ] as const;
    const seen = new Set(sources.map((s) => describeSource(s)));
    expect(seen.size).toBe(sources.length);
  });
});
