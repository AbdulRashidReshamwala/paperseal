import { defineConfig } from 'vitest/config';

// The browser test. `pnpm test` never runs it: the default include only matches *.test.ts.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
