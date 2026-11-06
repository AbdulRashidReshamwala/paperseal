/**
 * The apps' runtime `config.json` (spec/deploy.md, "App config.json"). Every field is optional:
 * a field that is missing, the wrong type or doesn't match its pattern is dropped, so a bad file
 * counts as empty rather than breaking the page.
 */
export interface WebConfig {
  teeUrl?: string;
  rpcUrl?: string;
  registry?: string;
  chainId?: number;
  chainName?: string;
  storageUrl?: string;
  storageBucket?: string;
  repository?: string;
  examId?: string;
  arkivWriters?: string;
  swarmApiUrl?: string;
  releaseTag?: string;
}

const url = /^https?:\/\/\S+$/;

/** The patterns in spec/web-config.schema.json. */
const patterns: Record<Exclude<keyof WebConfig, 'chainId'>, RegExp> = {
  teeUrl: url,
  rpcUrl: url,
  registry: /^0x[0-9a-fA-F]{40}$/,
  chainName: /^.+$/,
  storageUrl: url,
  storageBucket: /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/,
  repository: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  examId: /^0x[0-9a-f]{64}$/,
  arkivWriters: /^[^\n]*$/,
  swarmApiUrl: url,
  releaseTag: /^v[0-9]+\.[0-9]+\.[0-9]+$/,
};

/** Keeps only the valid fields of a parsed `config.json`. */
export function parseWebConfig(raw: unknown): WebConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const config: WebConfig = {};
  for (const [key, pattern] of Object.entries(patterns) as [Exclude<keyof WebConfig, 'chainId'>, RegExp][]) {
    const value = input[key];
    if (typeof value === 'string' && pattern.test(value)) config[key] = value;
  }
  if (typeof input.chainId === 'number' && Number.isInteger(input.chainId) && input.chainId > 0) config.chainId = input.chainId;
  return config;
}

/**
 * Reads `config.json` beside the page. A missing, unreadable or invalid file gives `{}`, and the
 * page renders with its build-time values.
 */
export async function loadWebConfig(url = './config.json', fetcher: typeof fetch = fetch): Promise<WebConfig> {
  try {
    const response = await fetcher(url, { cache: 'no-store' });
    if (!response.ok) return {};
    return parseWebConfig(await response.json());
  } catch {
    return {};
  }
}

/** `VITE_` value first, then `config.json`, then the built-in default (spec/deploy.md). */
export function pick(viteValue: string | undefined, configValue: string | undefined, fallback = ''): string {
  const own = viteValue?.trim();
  if (own) return own;
  return configValue ?? fallback;
}
