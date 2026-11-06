import { p256 } from '@noble/curves/nist';

import { arrayBuffer } from './buf';

/** Half the P-256 group order: a canonical low-s signature has s at or below this. */
const P256_HALF_ORDER = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n;

function isLowS(signature: Uint8Array): boolean {
  let s = 0n;
  for (const byte of signature.subarray(32)) s = (s << 8n) | BigInt(byte);
  return s <= P256_HALF_ORDER;
}

/**
 * Verifies a TEE signature: ECDSA over P-256 with SHA-256, as 64-byte `r || s`
 * with low `s`. `message` is the unhashed preimage, for example `encodeMessage`.
 */
export async function verifyTeeSignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  if (signature.length !== 64 || !isLowS(signature)) return false;
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  const key = await globalThis.crypto.subtle.importKey('raw', arrayBuffer(publicKey), algorithm, false, [
    'verify',
  ]);
  return globalThis.crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    arrayBuffer(signature),
    arrayBuffer(message),
  );
}

/**
 * The P-256 public keys that could have made a DER signature over a 32-byte hash, as 65-byte points.
 * Recovery has more than one answer, so the caller must pick the one it can identify some other way.
 * A passkey's public key comes from a create, so a browser that only ever sees a get recovers it here.
 */
export function recoverP256PublicKeys(signature: Uint8Array, hash: Uint8Array): Uint8Array[] {
  const parsed = p256.Signature.fromDER(signature);
  return [0, 1].flatMap((bit) => {
    try {
      return [parsed.addRecoveryBit(bit).recoverPublicKey(hash).toRawBytes(false)];
    } catch {
      return [];
    }
  });
}
