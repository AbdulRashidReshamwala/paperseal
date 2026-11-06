import { defineConfig } from 'vitest/config';

// Unit tests only. They mock fetch, the Arkiv writer and cast, so nothing touches the network.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node' } });
