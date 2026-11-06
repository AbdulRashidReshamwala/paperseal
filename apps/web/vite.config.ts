import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const port = 5171;

export default defineConfig(({ command, mode }) => {
  // Mock mode trusts a test attestation root (src/mockMode.ts). It exists for dev servers only, never a build,
  // and the root can only be given in that mode, so no other build or server can carry it.
  if (command === 'build' && mode === 'mock') throw new Error('Mock mode is for the e2e mock suite and cannot be built.');
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (mode !== 'mock' && env.VITE_MOCK_TRUST_ROOT) {
    throw new Error('VITE_MOCK_TRUST_ROOT is set outside mock mode. Unset it: a test attestation root must never reach a real build.');
  }
  // Demo keys are planted from a public seed (src/shared/demoKeys.ts). They exist for dev servers only, never a build.
  if (command === 'build' && mode === 'demo-keys') throw new Error('Demo keys are for `pnpm demo:keys` and cannot be built.');
  if (mode !== 'demo-keys' && mode !== 'mock' && env.VITE_DEMO_KEYS) {
    throw new Error('VITE_DEMO_KEYS is set outside the demo. Unset it: planted keys must never reach a real build.');
  }
  return {
    plugins: [react(), configFile(env)],
    server: { port, strictPort: true },
    preview: { port, strictPort: true },
  };
});

const spec = join(import.meta.dirname, '../../spec');

/** The `VITE_` setting behind each config.json field, as in src/shared/runtime-config.ts. */
const settings = {
  teeUrl: 'VITE_TEE_URL',
  rpcUrl: 'VITE_RPC_URL',
  registry: 'VITE_REGISTRY_ADDRESS',
  storageUrl: 'VITE_STORAGE_URL',
  storageBucket: 'VITE_TEE_STORAGE_BUCKET',
  repository: 'VITE_RELEASES_REPO',
  examId: 'VITE_EXAM_ID',
} as const;

/**
 * `config.json` beside the page (spec/deploy.md, "App config.json"), from this build's `VITE_` values
 * with empty ones left out, and the chain from constants.json. It is emitted into dist/ by a build and
 * served by the dev server. An operator overwrites it to point the same build at their own board.
 */
function configFile(env: Record<string, string>): Plugin {
  const body = (): string => {
    const constants = JSON.parse(readFileSync(join(spec, 'constants.json'), 'utf8')) as { chain: { chainId: number; name: string } };
    const config: Record<string, string | number> = { chainId: constants.chain.chainId, chainName: constants.chain.name };
    for (const [field, setting] of Object.entries(settings)) {
      const value = env[setting]?.trim();
      if (value) config[field] = value;
    }
    return `${JSON.stringify(config, null, 2)}\n`;
  };
  return {
    name: 'paperseal-config-json',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/config.json') return next();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(body());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'config.json', source: body() });
    },
  };
}
