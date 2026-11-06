import { chain, parseWebConfig, pick, type WebConfig } from '@paperseal/protocol';

/*
 * The runtime `config.json` beside index.html (spec/deploy.md, "App config.json"). main.tsx loads it
 * once, before any other module of the app is imported, so every module-level read below sees it.
 * It only supplies locators: mock mode and demo keys (mockMode.ts, demoKeys.ts) read none of it, and
 * every value is checked again by the attestation, chain and hash checks.
 */

let current: WebConfig = {};

/** The `VITE_` setting each config.json field stands in for. */
const settings = {
  VITE_TEE_URL: 'teeUrl',
  VITE_RPC_URL: 'rpcUrl',
  VITE_REGISTRY_ADDRESS: 'registry',
  VITE_STORAGE_URL: 'storageUrl',
  VITE_TEE_STORAGE_BUCKET: 'storageBucket',
  VITE_RELEASES_REPO: 'repository',
  VITE_EXAM_ID: 'examId',
  VITE_ARKIV_WRITERS: 'arkivWriters',
} as const satisfies Record<string, keyof WebConfig>;

/**
 * Keeps the valid fields of a parsed config.json. A file naming another chain than `chain.chainId`
 * loses its chain fields (`chainId`, `chainName`, `rpcUrl`, `registry`), so the app never reads
 * another chain's registry.
 */
export function setRuntimeConfig(raw: unknown): void {
  const config = parseWebConfig(raw);
  if (config.chainId === undefined || config.chainId === chain.chainId) {
    current = config;
    return;
  }
  const { chainId: _chainId, chainName: _chainName, rpcUrl: _rpcUrl, registry: _registry, ...rest } = config;
  current = rest;
}

/** The config.json in force, `{}` until main.tsx sets it. */
export function runtimeConfig(): WebConfig {
  return current;
}

/**
 * The app's settings: `import.meta.env`, with each setting above resolved by `pick` as the `VITE_`
 * value, then config.json, then unset. A setting with neither is left undefined.
 */
export function appEnv(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
  config: WebConfig = current,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...env };
  for (const [setting, field] of Object.entries(settings) as [keyof typeof settings, (typeof settings)[keyof typeof settings]][]) {
    merged[setting] = pick(env[setting], config[field]) || undefined;
  }
  return merged;
}
