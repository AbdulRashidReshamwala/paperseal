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

/** The `VITE_` setting behind each config.json field, as in src/runtime-config.ts. `repository` is resolved above. */
const settings = {
  teeUrl: 'VITE_TEE_URL',
  rpcUrl: 'VITE_RPC_URL',
  registry: 'VITE_REGISTRY_ADDRESS',
  storageUrl: 'VITE_STORAGE_URL',
  storageBucket: 'VITE_TEE_STORAGE_BUCKET',
  examId: 'VITE_EXAM_ID',
  arkivWriters: 'VITE_ARKIV_WRITERS',
  swarmApiUrl: 'VITE_SWARM_API_URL',
  releaseTag: 'VITE_RELEASE_TAG',
} as const;

/**
 * `config.json` beside the page (spec/deploy.md, "App config.json"): this build's `VITE_` values with
 * empty ones left out, the chain from constants.json and the repository. An operator overwrites it
 * to point the same build at their own board.
 */
function configJson(env: Record<string, string>, repo: string): string {
  const constants = JSON.parse(readFileSync(join(spec, 'constants.json'), 'utf8')) as { chain: { chainId: number; name: string } };
  const config: Record<string, string | number> = { chainId: constants.chain.chainId, chainName: constants.chain.name };
  for (const [field, setting] of Object.entries(settings)) {
    const value = env[setting]?.trim();
    if (value) config[field] = value;
  }
  config.repository = repo;
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The files served next to the page (spec/agent-verification.md, "Files Next to the Page"): emitted
 * into dist/ by a build and served by the dev server. `agent.md` is read from the spec each time,
 * so it never drifts. Every link is relative, because the page can be hosted from any folder.
 */
function siteFiles(env: Record<string, string>): Plugin {
  const repo = repository(env);
  const files = (): Record<string, string> => ({
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
    'config.json': configJson(env, repo),
  });
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
