import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  // WebAuthn needs a secure context, and http://localhost counts as one.
  server: { host: 'localhost', port: 0, strictPort: false },
  build: { target: 'es2023' },
  logLevel: 'warn',
});
