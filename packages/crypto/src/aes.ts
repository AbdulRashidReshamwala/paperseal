import { crypto as specCrypto } from '@paperseal/protocol';

import { buf } from './buf';

export const AES_GCM_NONCE_BYTES = 12;

async function importKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (key.length !== specCrypto.keyBytes) {
    throw new RangeError(`AES-256-GCM keys are ${String(specCrypto.keyBytes)} bytes`);
  }
  return globalThis.crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, [usage]);
}

function params(nonce: Uint8Array, aad?: Uint8Array): AesGcmParams {
  return { name: 'AES-GCM', iv: buf(nonce), tagLength: 128, ...(aad ? { additionalData: buf(aad) } : {}) };
}

/** AES-256-GCM through WebCrypto. Output framing is `nonce || ciphertext || tag`. */
export async function aesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const sealed = await globalThis.crypto.subtle.encrypt(
    params(nonce, aad),
    await importKey(key, 'encrypt'),
    buf(plaintext),
  );
  const out = new Uint8Array(nonce.length + sealed.byteLength);
  out.set(nonce);
  out.set(new Uint8Array(sealed), nonce.length);
  return out;
}

export async function aesGcmDecrypt(
  key: Uint8Array,
  sealed: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const nonce = sealed.subarray(0, AES_GCM_NONCE_BYTES);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    params(nonce, aad),
    await importKey(key, 'decrypt'),
    buf(sealed.subarray(AES_GCM_NONCE_BYTES)),
  );
  return new Uint8Array(plaintext);
}
