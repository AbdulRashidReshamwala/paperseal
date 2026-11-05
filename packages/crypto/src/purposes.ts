import {
  crypto as specCrypto,
  encodeQuestion,
  encodeRelease,
  FormatError,
  padding,
  padQuestion,
  unpad,
  utf8ToBytes,
  type Question,
  type ReleasePlaintext,
} from '@paperseal/protocol';

import { aesGcmDecrypt } from './aes';
import { hpkeOpen, hpkeSeal, type HpkeOptions } from './hpke';

/*
 * The Encryption table in spec/api.md, one helper per purpose. `info` comes from
 * `crypto.hpke.info` and `aad` from the examId (and, for `question`, the passkey), so no caller picks either.
 */

export type HpkePurpose = keyof typeof specCrypto.hpke.info;

const EXAM_ID_BYTES = 32;

const PUBLIC_KEY_BYTES = 65;

/**
 * The HPKE `info` and `aad` for a purpose and exam. `aad` is `examId`, except for `question`, where
 * it is `examId || passkeyPublicKey`, so one setter can't resubmit another's ciphertext. The
 * setter's passkey public key is required for `question` and refused for every other purpose.
 */
export function hpkeContext(purpose: 'question', examId: Uint8Array, passkeyPublicKey: Uint8Array): HpkeOptions;
export function hpkeContext(purpose: Exclude<HpkePurpose, 'question'>, examId: Uint8Array): HpkeOptions;
export function hpkeContext(purpose: HpkePurpose, examId: Uint8Array, passkeyPublicKey?: Uint8Array): HpkeOptions;
export function hpkeContext(purpose: HpkePurpose, examId: Uint8Array, passkeyPublicKey?: Uint8Array): HpkeOptions {
  if (examId.length !== EXAM_ID_BYTES) throw new RangeError('examId must be 32 bytes');
  const info = utf8ToBytes(specCrypto.hpke.info[purpose]);
  if (purpose !== 'question') {
    if (passkeyPublicKey !== undefined) throw new TypeError(`${purpose} aad is examId alone`);
    return { info, aad: examId.slice() };
  }
  if (passkeyPublicKey?.length !== PUBLIC_KEY_BYTES || passkeyPublicKey[0] !== 0x04) {
    throw new RangeError('question aad needs the setter passkey public key, a 65-byte uncompressed point');
  }
  const aad = new Uint8Array(EXAM_ID_BYTES + PUBLIC_KEY_BYTES);
  aad.set(examId, 0);
  aad.set(passkeyPublicKey, EXAM_ID_BYTES);
  return { info, aad };
}

/**
 * `question`, setter app to the TEE: the question JSON padded to `padding.questionBytes`. The `aad`
 * binds the setter's passkey public key.
 */
export function sealQuestion(
  encryptionPublicKey: Uint8Array,
  examId: Uint8Array,
  passkeyPublicKey: Uint8Array,
  question: Question,
): Promise<Uint8Array> {
  return hpkeSeal(
    encryptionPublicKey,
    padQuestion(encodeQuestion(question)),
    hpkeContext('question', examId, passkeyPublicKey),
  );
}

/** `release`, key holder app to the TEE: `abi.encode(share, signature, authenticatorData, clientDataJSON)`. */
export function sealRelease(
  encryptionPublicKey: Uint8Array,
  examId: Uint8Array,
  release: ReleasePlaintext,
): Promise<Uint8Array> {
  return hpkeSeal(encryptionPublicKey, encodeRelease(release), hpkeContext('release', examId));
}

/** `share`, TEE to a holder: opens the Shamir share with the holder's derived key. */
export function openShare(
  recipientKey: CryptoKeyPair,
  examId: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  return hpkeOpen(recipientKey, sealed, hpkeContext('share', examId));
}

/** `keyPriv`, TEE to a centre: opens the 32-byte `K_priv`. */
export async function openKeyPriv(
  recipientKey: CryptoKeyPair,
  examId: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  const keyPriv = await hpkeOpen(recipientKey, sealed, hpkeContext('keyPriv', examId));
  if (keyPriv.length !== specCrypto.keyBytes) {
    keyPriv.fill(0);
    throw new FormatError(`K_priv must be ${String(specCrypto.keyBytes)} bytes`);
  }
  return keyPriv;
}

const SEED_BYTES = 32;

/**
 * Opens the encrypted paper file: AES-256-GCM under `K` with `examId` as `aad`, over the 32-byte
 * `seed` and then the paper padded to `padding.paperBytes`. Returns the seed and the paper JSON
 * bytes, which is what `saltedPaperHash` covers.
 */
export async function openPaperFile(
  key: Uint8Array,
  examId: Uint8Array,
  file: Uint8Array,
): Promise<{ seed: Uint8Array; paper: Uint8Array }> {
  const plaintext = await aesGcmDecrypt(key, file, examId);
  if (plaintext.length !== SEED_BYTES + padding.paperBytes) {
    throw new FormatError('the paper file is not a seed and a padded paper');
  }
  return {
    seed: plaintext.slice(0, SEED_BYTES),
    paper: unpad(plaintext.subarray(SEED_BYTES), padding.paperBytes),
  };
}
