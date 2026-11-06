/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

import { defaultRepository, repositoryPattern } from './src/repository';

const port = 5172;

export default defineConfig(({ command, mode }) => {
  // Mock mode trusts a test attestation root (src/mockMode.ts). It exists for dev servers only, never a build,
  // and the root can only be given in that mode, so no other build or server can carry it.
  if (command === 'build' && mode === 'mock') throw new Error('Mock mode is for the e2e mock suite and cannot be built.');
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (mode !== 'mock' && env.VITE_MOCK_TRUST_ROOT) {
    throw new Error('VITE_MOCK_TRUST_ROOT is set outside mock mode. Unset it: a test attestation root must never reach a real build.');
  }
  return {
    // Relative paths, so anyone can host dist/ from any domain or folder.
    base: './',
    plugins: [react(), siteFiles(env)],
    server: { port, strictPort: true },
    preview: { port, strictPort: true },
    test: { setupFiles: ['./src/test-setup.ts'] },
  };
});

const here = import.meta.dirname;
const spec = join(here, '../../spec');

/** The repository: VITE_RELEASES_REPO, or the default in src/repository.ts. A bad value fails the build. */
function repository(env: Record<string, string>): string {
  const given = env.VITE_RELEASES_REPO?.trim();
  if (!given) return defaultRepository;
  if (!repositoryPattern.test(given)) throw new Error(`VITE_RELEASES_REPO must look like owner/name, not "${given}".`);
  return given;
}

/**
 * The files served next to the page (spec/agent-verification.md, "Files Next to the Page"): emitted
 * into dist/ by a build and served by the dev server. `agent.md` is read from the spec each time,
 * so it never drifts. Every link is relative, because the page can be hosted from any folder.
 */
function siteFiles(env: Record<string, string>): Plugin {
  const repo = repository(env);
  const files = (): Record<string, string> => {
    const constants = JSON.parse(readFileSync(join(spec, 'constants.json'), 'utf8')) as { chain: { chainId: number; name: string } };
    return {
      'agent.md': readFileSync(join(spec, 'agent-verification.md'), 'utf8'),
      'llms.txt': [
        '# Paper Seal Verifier',
        '',
        "> Paper Seal's public verifier for leak-proof exams. Anyone can check an exam from public sources.",
        '',
        '## Docs',
        '',
        '- [How to verify an exam](agent.md): the claims, the sources and how to read the report',
        `- [Source code](https://github.com/${repo}): the repository this page is built from`,
        '',
      ].join('\n'),
      'config.json': `${JSON.stringify(
        {
          registry: env.VITE_REGISTRY_ADDRESS ?? '',
          chainId: constants.chain.chainId,
          chainName: constants.chain.name,
          storageUrl: env.VITE_STORAGE_URL ?? '',
          repository: repo,
        },
        null,
        2,
      )}\n`,
    };
  };
  const types: Record<string, string> = {
    'agent.md': 'text/markdown; charset=utf-8',
    'llms.txt': 'text/plain; charset=utf-8',
    'config.json': 'application/json; charset=utf-8',
  };
  return {
    name: 'paperseal-site-files',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replaceAll('__PAPERSEAL_REPOSITORY__', repo) },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.replace(/^\//, '') ?? '';
        const body = types[name] ? files()[name] : undefined;
        if (body === undefined) return next();
        res.setHeader('Content-Type', types[name] ?? 'text/plain');
        res.end(body);
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(files())) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
