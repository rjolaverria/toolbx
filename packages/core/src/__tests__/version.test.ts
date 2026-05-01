import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TOOLBOX_VERSION } from '../version.js';

describe('TOOLBOX_VERSION', () => {
  it('matches the version field in @toolbox/core package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(TOOLBOX_VERSION).toBe(pkg.version);
  });
});
