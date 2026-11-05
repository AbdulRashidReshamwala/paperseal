import { drand } from '@paperseal/protocol';
import {
  Buffer,
  HttpCachingChain,
  HttpChainClient,
  timelockDecrypt as tlockDecrypt,
  timelockEncrypt as tlockEncrypt,
  type ChainClient,
} from 'tlock-js';

export type { ChainClient };

const DRAND_HOST = 'https://api.drand.sh';

/** A quicknet client pinned to the chain hash and public key in spec/constants.json. */
export function quicknetClient(host: string = DRAND_HOST): ChainClient {
  const options = {
    disableBeaconVerification: false,
    noCache: false,
    chainVerificationParams: { chainHash: drand.chainHash, publicKey: drand.publicKey },
  };
  const chain = new HttpCachingChain(`${host}/${drand.chainHash}`, options);
  return new HttpChainClient(chain, options);
}

/** Opens an age-armoured tlock ciphertext. Fails until the round has been published. */
export async function timelockDecrypt(
  ciphertext: string,
  client: ChainClient = quicknetClient(),
): Promise<Uint8Array> {
  return new Uint8Array(await tlockDecrypt(ciphertext, client));
}

/** The TEE does the sealing in production. This exists for tests and tooling. */
export function timelockEncrypt(
  round: number,
  plaintext: Uint8Array,
  client: ChainClient = quicknetClient(),
): Promise<string> {
  return tlockEncrypt(round, Buffer.from(plaintext), client);
}
