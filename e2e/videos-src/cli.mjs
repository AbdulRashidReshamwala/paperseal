#!/usr/bin/env node
// `pnpm video <name>` and `pnpm video --list`. Runs a video file through Vite's module loader, like
// e2e/demo/cli.mjs, so the real workspace packages load from source with no build step.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, '../../packages');
const alias = Object.fromEntries(
  [['keys/demo', 'keys/src/demo.ts'], ...['protocol', 'crypto', 'keys', 'chain', 'attestation', 'tee-client'].map((name) => [name, `${name}/src/index.ts`])].map(([name, file]) => [`@paperseal/${name}`, resolve(packages, file)]),
);

// Playwright reads this once, when it is first imported. See e2e/ffmpegLink.ts.
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(here, '../.browsers');

const server = await createServer({
  root: here,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias },
  ssr: { noExternal: [/^@paperseal\//] },
});

let code = 0;
try {
  const { main } = await server.ssrLoadModule('/lib/runner.ts');
  await main(process.argv.slice(2), (path) => server.ssrLoadModule(path));
} catch (error) {
  console.error(`\nFAILED ${error instanceof Error ? error.message : String(error)}`);
  code = 1;
}
await server.close();
process.exit(code);
