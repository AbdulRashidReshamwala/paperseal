import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { crypto as specCrypto, fromHex, unpad, utf8ToBytes } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import {
  aesGcmDecrypt,
  hpkeContext,
  hpkeDeriveKeyPair,
  hpkeOpen,
  hpkeSerializePublicKey,
  openKeyPriv,
  openShare,
  type HpkePurpose,
} from './index';

/*
 * Opens, in TypeScript, what Go sealed. tee/testdata/vectors.json is committed, so a missing
 * or malformed file fails here and never skips.
 */

interface HpkeVector {
  purpose: HpkePurpose;
  info: string;
  examId: string;
  recipientIkm: string;
  recipientPublicKey: string;
  plaintext: string;
  sealed: string;
}
interface Vectors {
  hpke: HpkeVector[];
  aes: { key: string; examId: string; plaintext: string; sealed: string };
  padding: { data: string; size: number; padded: string }[];
}

const path = resolve(import.meta.dirname, '../../../tee/testdata/vectors.json');
const vectors = JSON.parse(readFileSync(path, 'utf8')) as Vectors;

function hpkeVector(purpose: HpkePurpose): HpkeVector {
  const found = vectors.hpke.find((x) => x.purpose === purpose);
  if (!found) throw new Error(`vectors.json has no hpke vector for ${purpose}`);
  return found;
}

describe('tee/ vectors: HPKE sealed in Go', () => {
  it('covers all four purposes', () => {
    expect(vectors.hpke.map((v) => v.purpose).sort()).toEqual(Object.keys(specCrypto.hpke.info).sort());
  });

  describe.each(vectors.hpke)('$purpose', (v) => {
    const examId = fromHex(v.examId);
    const sealed = fromHex(v.sealed);

    it('uses the spec info string and the examId as aad', () => {
      const context = hpkeContext(v.purpose, examId);
      expect(context.info).toEqual(utf8ToBytes(v.info));
      expect(context.info).toEqual(utf8ToBytes(specCrypto.hpke.info[v.purpose]));
      expect(context.aad).toEqual(examId);
    });

    it('derives the recipient public key from the ikm', async () => {
      const keyPair = await hpkeDeriveKeyPair(fromHex(v.recipientIkm));
      expect(await hpkeSerializePublicKey(keyPair.publicKey)).toEqual(fromHex(v.recipientPublicKey));
    });

    it('opens with hpkeOpen', async () => {
      const keyPair = await hpkeDeriveKeyPair(fromHex(v.recipientIkm));
      const plaintext = await hpkeOpen(keyPair, sealed, hpkeContext(v.purpose, examId));
      expect(plaintext).toEqual(fromHex(v.plaintext));
    });

    it('does not open under another examId, purpose or a flipped byte', async () => {
      const keyPair = await hpkeDeriveKeyPair(fromHex(v.recipientIkm));
      await expect(hpkeOpen(keyPair, sealed, hpkeContext(v.purpose, new Uint8Array(32).fill(0x99)))).rejects.toThrow();
      const other: HpkePurpose = v.purpose === 'question' ? 'share' : 'question';
      await expect(hpkeOpen(keyPair, sealed, hpkeContext(other, examId))).rejects.toThrow();
      const tampered = sealed.slice();
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
      await expect(hpkeOpen(keyPair, tampered, hpkeContext(v.purpose, examId))).rejects.toThrow();
    });
  });

  it('opens share with openShare', async () => {
    const v = hpkeVector('share');
    const keyPair = await hpkeDeriveKeyPair(fromHex(v.recipientIkm));
    expect(await openShare(keyPair, fromHex(v.examId), fromHex(v.sealed))).toEqual(fromHex(v.plaintext));
  });

  it('opens keyPriv with openKeyPriv', async () => {
    const v = hpkeVector('keyPriv');
    const keyPair = await hpkeDeriveKeyPair(fromHex(v.recipientIkm));
    expect(await openKeyPriv(keyPair, fromHex(v.examId), fromHex(v.sealed))).toEqual(fromHex(v.plaintext));
  });
});

describe('tee/ vectors: AES-256-GCM sealed in Go', () => {
  const { aes } = vectors;
  const examId = fromHex(aes.examId);

  it('decrypts nonce || ciphertext || tag with the examId as aad', async () => {
    expect(await aesGcmDecrypt(fromHex(aes.key), fromHex(aes.sealed), examId)).toEqual(fromHex(aes.plaintext));
  });

  it('rejects a wrong examId, a wrong key and a flipped byte', async () => {
    const sealed = fromHex(aes.sealed);
    await expect(aesGcmDecrypt(fromHex(aes.key), sealed, new Uint8Array(32).fill(0x99))).rejects.toThrow();
    await expect(aesGcmDecrypt(new Uint8Array(32).fill(0xb2), sealed, examId)).rejects.toThrow();
    const tampered = sealed.slice();
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    await expect(aesGcmDecrypt(fromHex(aes.key), tampered, examId)).rejects.toThrow();
  });
});

describe('tee/ vectors: padding', () => {
  it.each(vectors.padding.filter((p) => p.padded !== ''))('unpads size $size, $data', ({ data, size, padded }) => {
    expect(unpad(fromHex(padded), size)).toEqual(fromHex(data));
  });
});
