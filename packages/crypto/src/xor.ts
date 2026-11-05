import { crypto as specCrypto } from '@paperseal/protocol';

/** K = K_pub XOR K_priv. Both halves must be exactly one key long. */
export function xorCombine(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== specCrypto.keyBytes || b.length !== specCrypto.keyBytes) {
    throw new RangeError(`both halves must be ${String(specCrypto.keyBytes)} bytes`);
  }
  return a.map((byte, i) => byte ^ (b[i] as number));
}
