import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const port = 5171;

export default defineConfig(({ command, mode }) => {
  // Mock mode trusts a test attestation root (src/mockMode.ts). It exists for dev servers only, never a build,
  // and the root can only be given in that mode, so no other build or server can carry it.
  if (command === 'build' && mode === 'mock') throw new Error('Mock mode is for the e2e mock suite and cannot be built.');
  if (mode !== 'mock' && loadEnv(mode, process.cwd(), 'VITE_').VITE_MOCK_TRUST_ROOT) {
    throw new Error('VITE_MOCK_TRUST_ROOT is set outside mock mode. Unset it: a test attestation root must never reach a real build.');
  }
  // Demo keys are planted from a public seed (src/shared/demoKeys.ts). They exist for dev servers only, never a build.
  if (command === 'build' && mode === 'demo-keys') throw new Error('Demo keys are for `pnpm demo:keys` and cannot be built.');
  if (mode !== 'demo-keys' && mode !== 'mock' && loadEnv(mode, process.cwd(), 'VITE_').VITE_DEMO_KEYS) {
    throw new Error('VITE_DEMO_KEYS is set outside the demo. Unset it: planted keys must never reach a real build.');
  }
  return config;
});

const config = {
  plugins: [react()],
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
};
