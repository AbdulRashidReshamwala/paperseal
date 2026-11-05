#!/usr/bin/env node
// Runs the TypeScript commands through Vite's module loader, the same way the other e2e code runs
// under Vitest, so the real workspace packages load from their source with no build step.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, '../../packages');
const alias = Object.fromEntries(
  ['protocol', 'crypto', 'keys', 'chain', 'attestation', 'tee-client'].map((name) => [`@paperseal/${name}`, resolve(packages, name, 'src/index.ts')]),
);

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
  const mod = await server.ssrLoadModule('/main.ts');
  await mod.main(process.argv.slice(2));
  code = process.exitCode ?? 0;
} catch (error) {
  console.error(`\nERROR ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  code = 1;
} finally {
  await server.close();
}
process.exit(code);
