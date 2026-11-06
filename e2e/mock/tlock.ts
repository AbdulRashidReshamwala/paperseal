import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { quicknetClient } from '@paperseal/crypto';

/*
 * `tlock-js` lives under packages/crypto, which has no encrypt of its own (only the TEE seals). The mock
 * machine seals with the same library against the real quicknet chain, so the browser opens the result
 * with real drand beacons.
 */

type Encrypt = (round: number, payload: Buffer, client: ReturnType<typeof quicknetClient>) => Promise<string>;
let cached: Encrypt | null = null;

export async function timelockEncrypt(round: number, payload: Uint8Array): Promise<string> {
  if (!cached) {
    const require = createRequire(resolve(import.meta.dirname, '../../packages/crypto/package.json'));
    const module = (await import(pathToFileURL(require.resolve('tlock-js')).href)) as { timelockEncrypt: Encrypt };
    cached = module.timelockEncrypt;
  }
  return cached(round, Buffer.from(payload), quicknetClient());
}
