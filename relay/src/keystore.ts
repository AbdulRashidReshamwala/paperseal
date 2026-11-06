import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { getAddress, type Address } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import type { KeystoreConfig } from './config';

/*
 * The relay signs Arkiv writes with a key from a Foundry keystore. cast decrypts it with the
 * password file, whose path is all this process ever handles. The key comes back on cast's stdout
 * and goes straight into viem's `privateKeyToAccount`, so it lives only in this process's memory.
 * It is never printed, logged or written to disk, and cast's stdout is never quoted in an error,
 * because on success it is the key itself.
 */

export type Spawn = typeof nodeSpawn;

export interface CastDeps {
  spawn?: Spawn;
  exists?: (path: string) => boolean;
  timeoutMs?: number;
}

/** `cast wallet private-key`: prints the keystore's key. Pure, so tests and dry-check inspect it. */
export function castPrivateKeyArgs(config: KeystoreConfig): string[] {
  return ['wallet', 'private-key', '--account', config.account, '--password-file', config.passwordFile];
}

/** `cast wallet address`: prints only the keystore's address. `status` uses it, so it holds no key. */
export function castAddressArgs(config: KeystoreConfig): string[] {
  return ['wallet', 'address', '--account', config.account, '--password-file', config.passwordFile];
}

/** Anything that looks like a 32-byte secret is cut from cast's error output before it is shown. */
export function scrubCastOutput(text: string): string {
  return text.replace(/(0x)?[0-9a-fA-F]{64}/g, '[redacted]').trim().slice(0, 600);
}

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreError';
  }
}

/** Runs cast and resolves with its trimmed stdout. Errors carry only scrubbed stderr. */
function runCast(config: KeystoreConfig, args: string[], deps: CastDeps): Promise<string> {
  const exists = deps.exists ?? existsSync;
  const spawn = deps.spawn ?? nodeSpawn;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const what = `cast ${args.slice(0, 2).join(' ')} --account ${config.account}`;
  if (!exists(config.passwordFile)) {
    return Promise.reject(
      new KeystoreError(
        `the password file ${config.passwordFile} does not exist (set RELAY_PASSWORD_FILE; its contents are never read here)`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    let child: ReturnType<Spawn>;
    try {
      // stdin is closed, so cast can never stop and prompt for a password.
      child = spawn(config.cast, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new KeystoreError(`could not run ${config.cast}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new KeystoreError(`${what} did not finish in ${String(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      out = '';
      const hint = error.code === 'ENOENT' ? ' (install Foundry, or put cast on PATH or at ~/.foundry/bin/cast)' : '';
      reject(new KeystoreError(`could not run ${config.cast}: ${error.code ?? error.message}${hint}`));
    });
    child.once('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        out = '';
        const detail = scrubCastOutput(err);
        reject(new KeystoreError(`${what} exited ${String(code)}${detail ? `: ${detail}` : ''}`));
        return;
      }
      const text = out.trim();
      out = '';
      resolve(text);
    });
  });
}

/** The relay's signer. The key is checked by shape only, and never echoed if it is wrong. */
export async function loadSigner(config: KeystoreConfig, deps: CastDeps = {}): Promise<PrivateKeyAccount> {
  const key = await runCast(config, castPrivateKeyArgs(config), deps);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new KeystoreError('cast wallet private-key did not print a 32-byte hex key (its output is not shown)');
  }
  return privateKeyToAccount(key as `0x${string}`);
}

/** The keystore's address, for `status` without `--writer`. cast decrypts; no key reaches this process. */
export async function keystoreAddress(config: KeystoreConfig, deps: CastDeps = {}): Promise<Address> {
  const text = await runCast(config, castAddressArgs(config), deps);
  const match = /0x[0-9a-fA-F]{40}/.exec(text);
  if (!match) throw new KeystoreError('cast wallet address did not print an address');
  return getAddress(match[0]);
}
