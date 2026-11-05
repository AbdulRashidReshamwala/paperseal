import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = 5171;

export default defineConfig({
  plugins: [react()],
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
});
