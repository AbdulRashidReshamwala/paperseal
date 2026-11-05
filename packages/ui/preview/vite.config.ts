import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = 5179;

// Separate from the apps: a static page of the design system, built with relative paths.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  // Reuses the web app's icons rather than keeping a third copy.
  publicDir: '../../../apps/web/public',
  plugins: [react()],
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
