import { defineConfig } from 'vitest/config';

import { browsersPath, linkInstalledFfmpeg } from './ffmpegLink';

linkInstalledFfmpeg();

// Recordings run one after another, because each drives a real browser and some share ports and a chain.
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 900_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: 1,
    env: { PLAYWRIGHT_BROWSERS_PATH: browsersPath },
  },
});
