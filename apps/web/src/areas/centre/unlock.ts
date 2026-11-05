import { aesGcmDecrypt, xorCombine } from '@paperseal/crypto';

/**
 * The README's Decrypt step: K = K_pub XOR K_priv opens the paper. Centre only.
 * The combined key is wiped after use.
 */
export async function decryptPaper(
  kPub: Uint8Array,
  kPriv: Uint8Array,
  encryptedPaper: Uint8Array,
): Promise<Uint8Array> {
  const key = xorCombine(kPub, kPriv);
  try {
    return await aesGcmDecrypt(key, encryptedPaper);
  } finally {
    key.fill(0);
  }
}
