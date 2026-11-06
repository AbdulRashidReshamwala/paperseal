import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';

/*
 * The relay's environment. Every value here is a name or a path, except the Arkiv access key,
 * which is registered with output.ts so it is never printed. The keystore password file is only a
 * path: it is handed to `cast --password-file` and never opened by this process.
 */

export interface KeystoreConfig {
  /** A Foundry keystore name under ~/.foundry/keystores. */
  account: string;
  /** Path only. cast reads it; this process never does. */
  passwordFile: string;
  /** The cast executable. */
  cast: string;
}

export interface AccessKey {
  value: string | undefined;
  /** Where it came from (`ARKIV_ACCESS_KEY` or the file's path), for the header line. Never the value. */
  source: string | undefined;
}

export interface RelayEnv {
  keystore: KeystoreConfig;
  accessKey: AccessKey;
}

interface EnvDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
}

export const defaultKeystoreAccount = 'paperseal-board';

/** cast on PATH, else Foundry's default install location, else plain `cast` so spawn reports it. */
export function findCast({ env = process.env, home = homedir(), exists = existsSync }: EnvDeps = {}): string {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && exists(resolve(dir, 'cast'))) return resolve(dir, 'cast');
  }
  const foundry = resolve(home, '.foundry/bin/cast');
  return exists(foundry) ? foundry : 'cast';
}

/** The value of `ARKIV_ACCESS_KEY=` in a dotenv-style file, without quotes, or undefined. */
export function accessKeyFromEnvFile(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?ARKIV_ACCESS_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = (match[1] ?? '').replace(/^(['"])(.*)\1$/, '$2');
    return value === '' ? undefined : value;
  }
  return undefined;
}

export function accessKeyFile(home = homedir()): string {
  return resolve(home, '.paperseal/arkiv-relay.env');
}

export function loadAccessKey({ env = process.env, home = homedir(), exists = existsSync, readText = (p) => readFileSync(p, 'utf8') }: EnvDeps = {}): AccessKey {
  const fromEnv = env.ARKIV_ACCESS_KEY?.trim();
  if (fromEnv) return { value: fromEnv, source: 'ARKIV_ACCESS_KEY' };
  const file = accessKeyFile(home);
  if (exists(file)) {
    const value = accessKeyFromEnvFile(readText(file));
    if (value) return { value, source: file };
  }
  return { value: undefined, source: undefined };
}

export function relayEnv(deps: EnvDeps = {}): RelayEnv {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  return {
    keystore: {
      account: env.RELAY_KEYSTORE?.trim() || defaultKeystoreAccount,
      passwordFile: env.RELAY_PASSWORD_FILE?.trim() || resolve(home, '.paperseal/board-keystore-password'),
      cast: findCast({ ...deps, env, home }),
    },
    accessKey: loadAccessKey({ ...deps, env, home }),
  };
}
