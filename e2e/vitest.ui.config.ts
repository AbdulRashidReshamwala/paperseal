import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { browsersPath, linkInstalledFfmpeg } from './ffmpegLink';

// The live run records videos, which needs the linked ffmpeg.
linkInstalledFfmpeg();

const packages = resolve(import.meta.dirname, '../packages');
const alias = Object.fromEntries([
  ['@paperseal/keys/demo', resolve(packages, 'keys/src/demo.ts')],
  ...['protocol', 'crypto', 'keys', 'chain', 'attestation', 'tee-client'].map((name) => [`@paperseal/${name}`, resolve(packages, name, 'src/index.ts')]),
]);

/*
 * The UI suite: real Chrome clicking the real screens. `ui/local.ui.ts` is the local layer (anvil, a
 * stub TEE, stub storage). `ui/live.ui-live.ts` is the real run against the deployed TEE and Sepolia;
 * it is not part of `pnpm ui`, see the `ui:live` script. `ui/mock.ui-mock.ts` is the same script against a
 * mock sealed machine and a local chain (`ui:mock`), for fast recordings that say "Mock data" on every screen.
 * `ui/demoKeys.ui-demo.ts` is a whole exam in one tab with demo keys, on the same mock world (`ui:demo`).
 */
export default defineConfig({
  resolve: { alias },
  test: {
    include: [process.env.UI_LIVE === '1' ? 'ui/**/*.ui-live.ts' : process.env.UI_MOCK === '1' ? 'ui/**/*.ui-mock.ts' : process.env.UI_DEMO === '1' ? 'ui/**/*.ui-demo.ts' : 'ui/**/*.ui.ts'],
    environment: 'node',
    testTimeout: 1_500_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    maxWorkers: 1,
    env: { PLAYWRIGHT_BROWSERS_PATH: browsersPath },
  },
});
