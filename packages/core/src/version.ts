import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved at module load. Works for both the built layout (`dist/version.js`)
// and the in-source layout used by Vitest (`src/version.ts`); in both cases
// `package.json` sits one level up from the directory of this file.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(moduleDir, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

export const TOOLBOX_VERSION: string = pkg.version;
