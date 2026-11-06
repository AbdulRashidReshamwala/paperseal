#!/usr/bin/env node
// Runs a demo TypeScript entry (main.ts or check.ts) through Vite's module loader, like e2e/live/cli.mjs,
// so the real workspace packages load from source with no build step.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, '../../packages');
const alias = Object.fromEntries(
  ['protocol', 'crypto', 'keys', 'chain', 'attestation', 'tee-client'].map((name) => [`@paperseal/${name}`, resolve(packages, name, 'src/index.ts')]),
);

const entry = process.argv[2];
if (entry !== 'main' && entry !== 'check') {
  console.error('usage: cli.mjs main|check [args]');
  process.exit(2);
}

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
  const mod = await server.ssrLoadModule(`/${entry}.ts`);
  await mod.main(process.argv.slice(3));
  code = process.exitCode ?? 0;
} catch (error) {
  console.error(`\nERROR ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  code = 1;
}
// main.ts keeps running until Ctrl-C and closes its own browser before it returns.
await server.close();
process.exit(code);
