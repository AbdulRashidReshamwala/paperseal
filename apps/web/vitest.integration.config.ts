import { defineConfig } from 'vitest/config';

/** The anvil integration test. Not part of `pnpm test`: run it with `pnpm test:integration`. */
export default defineConfig({
  test: {
    include: ['src/integration/**/*.integration.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
