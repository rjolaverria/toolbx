import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lazily resolved on first call and cached, so `import '@toolbox/core'` does
// not perform a synchronous `readFileSync` for consumers that never need
// the version. Works for both the built layout (`dist/version.js`) and the
// in-source layout used by Vitest (`src/version.ts`); in both cases
// `package.json` sits one level up from the directory of this file.
let cachedVersion: string | undefined;

export function getToolBoxVersion(): string {
  if (cachedVersion === undefined) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(moduleDir, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    cachedVersion = pkg.version;
  }
  return cachedVersion;
}
