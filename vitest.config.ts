import { defineConfig } from 'vitest/config';

// Coverage thresholds are configured per-package via glob keys rather than
// inside each package's `vitest.config.ts`. Vitest treats `coverage` as a
// non-project option (see `NonProjectOptions` in `vitest`'s types), so it can
// only be configured at the workspace root. Each glob entry below acts as a
// floor for the matching package — see CLAUDE.md > Tests for the policy.
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['apps/*/src/**', 'packages/*/src/**'],
      exclude: ['**/__fixtures__/**', '**/__tests__/**'],
      reportOnFailure: true,
      thresholds: {
        'apps/cli/src/**': {
          statements: 73,
          branches: 72,
          functions: 60,
          lines: 73,
        },
        'packages/core/src/**': {
          statements: 87,
          branches: 85,
          functions: 87,
          lines: 88,
        },
        'packages/mcp-gateway/src/**': {
          statements: 87,
          branches: 76,
          functions: 88,
          lines: 88,
        },
        // The inputSchema export probe builds an in-memory TypeScript program,
        // whose `CompilerHost` must implement a few required methods (writeFile,
        // getNewLine, readFile) that a parse/bind-only, no-emit program never
        // calls — so functions/statements sit a little below the other packages.
        'packages/custom-tools/src/**': {
          statements: 94,
          branches: 76,
          functions: 85,
          lines: 94,
        },
      },
    },
  },
});
