import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = 5172;

export default defineConfig({
  // Relative paths, so anyone can host dist/ from any domain or folder.
  base: './',
  plugins: [react()],
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
});
