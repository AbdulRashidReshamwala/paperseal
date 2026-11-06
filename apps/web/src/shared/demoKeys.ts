import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/*
 * Demo keys (`pnpm demo:keys`): one tab acts as every person in an exam, each with a planted key from
 * a public seed. See apps/web/src/demo. This file is the only door to that code. It is shut unless Vite
 * runs in its own `demo-keys` mode, or in the e2e mock suite's mode, with VITE_DEMO_KEYS=1.
 *
 * It cannot reach a production build, for three reasons:
 *   - Vite replaces `import.meta.env.MODE` with a literal, so in a production build the branches below
 *     are dead code and are removed, together with the dynamic imports inside them. The test inside each
 *     function has to stay there: the bundler only removes a branch it can decide within this file.
 *   - `vite.config.ts` refuses to build in `demo-keys` mode, and refuses VITE_DEMO_KEYS in any other.
 *   - `demoKeys.test.ts` builds the app and checks the output holds no trace of it.
 */

const on = (import.meta.env.MODE === 'demo-keys' || import.meta.env.MODE === 'mock') && import.meta.env.VITE_DEMO_KEYS === '1';

/** The bar across the top of the app. Null outside demo mode. */
export function demoBar(): LazyExoticComponent<ComponentType> | null {
  if (!on) return null;
  return lazy(() => import('../demo/DemoBar'));
}

/** The `credentials` option for `createWebAuthnKeys`, empty outside demo mode, so the browser's real one applies. */
export function credentialsOption(): { credentials?: Pick<CredentialsContainer, 'create' | 'get'> } {
  if (!on) return {};
  const demo = () => import('../demo/credentials').then(({ demoCredentials }) => demoCredentials());
  return {
    credentials: {
      create: async (options) => (await demo()).create(options),
      get: async (options) => (await demo()).get(options),
    },
  };
}
