import shared from '../packages/eslint.config.mjs';

/** Paper and K_priv handling. Keyholder code and the shared release flow must never reach it. */
const paperCrypto = {
  name: '@paperseal/crypto',
  importNames: ['aesGcmDecrypt', 'aesGcmEncrypt', 'xorCombine'],
  message: 'Keyholder code must not import paper or K_priv handling.',
};
const centreCode = {
  group: ['**/centre', '**/centre/**'],
  message: 'Keyholder code must not import from the centre area.',
};

export default [
  ...shared,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
  },
  {
    files: ['web/src/areas/keyholder/**', 'web/src/release/**'],
    ignores: ['**/*.test.*'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { paths: [paperCrypto], patterns: [centreCode] },
      ],
    },
  },
  {
    files: ['verifier/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@paperseal/keys', message: 'The verifier uses no passkeys.' }],
          patterns: [
            { group: ['@paperseal/web', '**/apps/web/**', '**/web/src/**'], message: 'The verifier is independent of apps/web.' },
          ],
        },
      ],
    },
  },
];
