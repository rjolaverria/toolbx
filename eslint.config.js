// @ts-check
import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: tseslint.configs.recommendedTypeChecked,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // CLI integration tests live in `apps/cli/test/`, which is not part of
    // the package's emit `tsconfig.json` (that would push tests into
    // `dist/`). They have their own non-emit `tsconfig.test.json`; point
    // the type-aware parser at it explicitly so the lint rules still see
    // the full type graph.
    files: ['apps/cli/test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['apps/cli/tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Config files sit outside tsconfig projects — disable type-aware rules for them
    files: ['**/*.config.ts', '**/*.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Plain Node scripts (test fixtures, etc.) — give them Node globals
    files: ['**/*.mjs', '**/*.cjs', '**/__fixtures__/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Must be last to override any formatting rules from configs above
  prettierConfig,
);
