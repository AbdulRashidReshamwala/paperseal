// The flat config of packages/eslint.config.mjs, for a Node package with no React. relay/ sits
// outside packages/, so ESLint would not find that one by walking up.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  { files: ['**/*.mjs'], languageOptions: { globals: { ...globals.node } } },
);
