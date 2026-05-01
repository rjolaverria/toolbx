import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getToolboxVersion } from '../version.js';

describe('getToolboxVersion', () => {
  it('returns the version field in @toolbox/core package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(getToolboxVersion()).toBe(pkg.version);
  });

  it('caches the resolved version across calls', () => {
    expect(getToolboxVersion()).toBe(getToolboxVersion());
  });
});
