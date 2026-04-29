// @ts-check
import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
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
    // Config files sit outside tsconfig projects — disable type-aware rules for them
    files: ['**/*.config.ts', '**/*.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Must be last to override any formatting rules from configs above
  prettierConfig,
);
