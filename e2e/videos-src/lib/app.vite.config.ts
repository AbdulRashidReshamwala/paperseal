import { resolve } from 'node:path';

import type { ConfigEnv, UserConfig } from 'vite';

import webConfig from '../../../apps/web/vite.config';

/*
 * The web app's own config, with Vite's dependency cache moved aside. A dev server may already be
 * running on the app, and two servers sharing one cache can rebuild it under each other.
 */
export default function config(env: ConfigEnv): UserConfig {
  const base = (webConfig as unknown as (e: ConfigEnv) => UserConfig)(env);
  return { ...base, cacheDir: resolve(import.meta.dirname, `../../videos/.work/vite-${env.mode}`) };
}
