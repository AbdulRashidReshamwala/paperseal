import { chain, pick, type WebConfig } from '@paperseal/protocol';
import { swarm } from '@paperseal/swarm';

import { mockMode } from './mockMode';

/*
 * The page's runtime `config.json` (spec/deploy.md, "App config.json"). main.tsx loads it and calls
 * `setRuntimeConfig` once, before it imports the rest of the app, so every module-level default
 * below is read after it is set. Until then, and in tests, the config is `{}`.
 */

let current: WebConfig = {};

/**
 * Sets the config for this visit. Mock mode never takes anything from it. `chainId` and `chainName`
 * only describe the chain: a file naming another chain than spec/constants.json has them dropped,
 * and the page never switches chains.
 */
export function setRuntimeConfig(config: WebConfig): void {
  if (mockMode) {
    current = {};
    return;
  }
  if (config.chainId !== undefined && config.chainId !== chain.chainId) {
    const rest = { ...config };
    delete rest.chainId;
    delete rest.chainName;
    current = rest;
    return;
  }
  current = config;
}

export function runtimeConfig(): WebConfig {
  return current;
}

export type ViteEnv = Record<string, string | undefined>;

export const viteEnv: ViteEnv = import.meta.env as ViteEnv;

/** The page's defaults: a `VITE_` value, then `config.json`, then the built-in default. */
export function resolveDefaults(env: ViteEnv = viteEnv, config: WebConfig = runtimeConfig()) {
  return {
    rpcUrl: pick(env.VITE_RPC_URL, config.rpcUrl),
    teeUrl: pick(env.VITE_TEE_URL, config.teeUrl),
    storageUrl: pick(env.VITE_STORAGE_URL, config.storageUrl),
    storageBucket: pick(env.VITE_TEE_STORAGE_BUCKET, config.storageBucket),
    registryAddress: pick(env.VITE_REGISTRY_ADDRESS, config.registry),
    examId: pick(env.VITE_EXAM_ID, config.examId),
    arkivWriters: pick(env.VITE_ARKIV_WRITERS, config.arkivWriters),
    swarmApiUrl: pick(env.VITE_SWARM_API_URL, config.swarmApiUrl, swarm.defaultApiUrl),
    releaseTag: pick(env.VITE_RELEASE_TAG, config.releaseTag),
  };
}
