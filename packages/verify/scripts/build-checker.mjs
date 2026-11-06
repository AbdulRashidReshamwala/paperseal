// Bundles src/cli.ts into dist/paperseal-verify.mjs: one ESM file for Node 20+, with every
// dependency inlined. The same source and lockfile give the same bytes, so a release's
// checkerSha256 can be rebuilt by anyone. Run with PAPERSEAL_VERSION=v<x.y.z>.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const version = process.env.PAPERSEAL_VERSION ?? 'v0.0.0';
if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error(`PAPERSEAL_VERSION must look like v1.2.3, not "${version}".`);
const repository = process.env.PAPERSEAL_REPOSITORY ?? 'AbdulRashidReshamwala/paperseal';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`PAPERSEAL_REPOSITORY must look like owner/name, not "${repository}".`);

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/paperseal-verify.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'eof',
  charset: 'utf8',
  logLevel: 'warning',
  define: {
    'process.env.PAPERSEAL_VERSION': JSON.stringify(version),
    'process.env.PAPERSEAL_REPOSITORY': JSON.stringify(repository),
  },
  // Some dependencies are CommonJS and call require for Node built-ins.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __papersealCreateRequire } from 'node:module';\nconst require = __papersealCreateRequire(import.meta.url);",
  },
});
