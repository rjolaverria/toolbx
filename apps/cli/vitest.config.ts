import { configDefaults, defineProject } from 'vitest/config';

// The end-to-end integration suite spawns the built `tlbx` binary and is
// driven exclusively through `pnpm test:integration` (see
// `vitest.integration.config.ts` at the repo root). Keep it out of the
// default project glob so `pnpm test` / `pnpm test:run` stay fast and don't
// depend on `apps/cli/dist` being built.
export default defineProject({
  test: {
    name: 'cli',
    environment: 'node',
    exclude: [...configDefaults.exclude, 'test/integration/**'],
  },
});
