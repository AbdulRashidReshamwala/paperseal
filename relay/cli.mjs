#!/usr/bin/env node
// Runs the relay's TypeScript through Vite's module loader, as e2e/live/cli.mjs does, so the
// workspace packages load from their source with no build step.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, '../packages');
const alias = Object.fromEntries(
  ['protocol', 'arkiv', 'tee-client'].map((name) => [`@paperseal/${name}`, resolve(packages, name, 'src/index.ts')]),
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

let code;
try {
  const mod = await server.ssrLoadModule('/src/main.ts');
  // main prints its own errors, with the access key redacted.
  await mod.main(process.argv.slice(2));
  code = process.exitCode ?? 0;
} catch (error) {
  // Only a failure to load the code reaches here; it holds no secret.
  console.error(`\nERROR ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  code = 1;
} finally {
  await server.close();
}
process.exit(code);
