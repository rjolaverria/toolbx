import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Top-level integration-only config. Kept separate from the default
// `vitest.config.ts` so `pnpm test` and `pnpm test:run` do not pull in the
// slower end-to-end suite — `pnpm test:integration` is the single entry
// point. The Turbo `test:integration` task lists `build` as a dependency,
// so the CLI dist is guaranteed to exist when the suite spawns it as a
// subprocess.
//
// `root` is pinned to this file's directory so the suite can be invoked
// from any package (e.g. Turbo runs the per-package script from `apps/cli`)
// and the `include` glob still resolves against the workspace root.
const ROOT = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: ROOT,
  test: {
    name: 'cli-integration',
    environment: 'node',
    include: ['apps/cli/test/integration/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: false,
  },
});
