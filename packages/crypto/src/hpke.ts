import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { concatBytes, crypto as specCrypto } from '@paperseal/protocol';

import { arrayBuffer } from './buf';

const expected = {
  kem: 'DHKEM(P-256, HKDF-SHA256)',
  kdf: 'HKDF-SHA256',
  aead: 'AES-256-GCM',
};
const { kem, kdf, aead } = specCrypto.hpke;
if (JSON.stringify({ kem, kdf, aead }) !== JSON.stringify(expected)) {
  throw new Error('spec/constants.json names an HPKE suite this package does not build');
}

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

/** Length of the KEM encapsulated key at the front of a sealed message. */
export const HPKE_ENC_BYTES = 65;

/**
 * Both are required, so no call can leave them out. Callers get them from `hpkeContext`
 * (or a purpose helper in ./purposes) rather than picking strings.
 */
export interface HpkeOptions {
  info: Uint8Array;
  aad: Uint8Array;
}

/** Derives a keypair from secret input keying material with RFC 9180 DeriveKeyPair. */
export function hpkeDeriveKeyPair(ikm: Uint8Array): Promise<CryptoKeyPair> {
  return suite.kem.deriveKeyPair(arrayBuffer(ikm));
}

export async function hpkeSerializePublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await suite.kem.serializePublicKey(key));
}

/** Seals to an uncompressed P-256 public key. Output framing is `enc || ciphertext`. */
export async function hpkeSeal(
  recipientPublicKey: Uint8Array,
  plaintext: Uint8Array,
  options: HpkeOptions,
): Promise<Uint8Array> {
  const recipient = await suite.kem.deserializePublicKey(arrayBuffer(recipientPublicKey));
  const { ct, enc } = await suite.seal(
    {
      recipientPublicKey: recipient,
      info: arrayBuffer(options.info),
    },
    arrayBuffer(plaintext),
    arrayBuffer(options.aad),
  );
  return concatBytes(new Uint8Array(enc), new Uint8Array(ct));
}

export async function hpkeOpen(
  recipientKey: CryptoKeyPair,
  sealed: Uint8Array,
  options: HpkeOptions,
): Promise<Uint8Array> {
  if (sealed.length < HPKE_ENC_BYTES) throw new RangeError('sealed message is too short');
  const plaintext = await suite.open(
    {
      recipientKey,
      enc: arrayBuffer(sealed.subarray(0, HPKE_ENC_BYTES)),
      info: arrayBuffer(options.info),
    },
    arrayBuffer(sealed.subarray(HPKE_ENC_BYTES)),
    arrayBuffer(options.aad),
  );
  return new Uint8Array(plaintext);
}
