import { configDefaults, defineProject } from 'vitest/config';

// The end-to-end integration suite spawns the built `tlbx` binary and is
// driven exclusively through `pnpm test:integration` (see
// `vitest.integration.config.ts` at the repo root). Keep it out of the
// default project glob so `pnpm test` / `pnpm test:run` stay fast and don't
// depend on `apps/cli/dist` being built.
//
// `dist/**` is excluded so the suite behaves identically whether or not the
// package has been built. Without this, a `pnpm build` before `pnpm test`
// (e.g. in the `coverage` CI job) causes vitest to also pick up the
// compiled `dist/**/*.test.js` copies, which doubles the suite, can change
// coverage outcomes, and is wasted work.
export default defineProject({
  test: {
    name: 'cli',
    environment: 'node',
    exclude: [...configDefaults.exclude, 'dist/**', 'test/integration/**'],
  },
});
