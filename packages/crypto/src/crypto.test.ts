import {
  concatBytes,
  constants,
  decodeRelease,
  drand,
  padPaper,
  parseQuestion,
  roundTimeSeconds,
  unpadQuestion,
} from '@paperseal/protocol';
import { Buffer as TlockBuffer, defaultChainInfo, timelockEncrypt, type ChainClient, type ChainInfo } from 'tlock-js';
import { describe, expect, it, vi } from 'vitest';

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  HPKE_ENC_BYTES,
  hpkeContext,
  hpkeDeriveKeyPair,
  hpkeOpen,
  hpkeSeal,
  hpkeSerializePublicKey,
  openKeyPriv,
  openPaperFile,
  openShare,
  quicknetClient,
  sealQuestion,
  sealRelease,
  timelockDecrypt,
  verifyTeeSignature,
  xorCombine,
} from './index';

const bytes = (text: string) => new TextEncoder().encode(text);
const examId = new Uint8Array(32).fill(0xe1);
const key = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

describe('AES-256-GCM', () => {
  it('round-trips with the examId as aad and frames nonce, ciphertext, tag', async () => {
    const k = key();
    const sealed = await aesGcmEncrypt(k, bytes('paper'), examId);
    expect(sealed).toHaveLength(12 + 5 + 16);
    expect(await aesGcmDecrypt(k, sealed, examId)).toEqual(bytes('paper'));
    await expect(aesGcmDecrypt(k, sealed, new Uint8Array(32))).rejects.toThrow();
  });

  it('uses a fresh nonce each time', async () => {
    const k = key();
    const [a, b] = await Promise.all([aesGcmEncrypt(k, bytes('x'), examId), aesGcmEncrypt(k, bytes('x'), examId)]);
    expect(a.subarray(0, 12)).not.toEqual(b.subarray(0, 12));
  });

  it('rejects tampering, a wrong key, a short key and a short message', async () => {
    const k = key();
    const sealed = await aesGcmEncrypt(k, bytes('paper'), examId);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    await expect(aesGcmDecrypt(k, tampered, examId)).rejects.toThrow();
    await expect(aesGcmDecrypt(key(), sealed, examId)).rejects.toThrow();
    await expect(aesGcmEncrypt(new Uint8Array(16), bytes('x'), examId)).rejects.toThrow(RangeError);
    await expect(aesGcmDecrypt(k, sealed.subarray(0, 20), examId)).rejects.toThrow(RangeError);
  });
});

const ctx = hpkeContext('share', examId);

describe('HPKE', () => {
  it('round-trips to an uncompressed P-256 key', async () => {
    const pair = await hpkeDeriveKeyPair(key());
    const publicKey = await hpkeSerializePublicKey(pair.publicKey);
    expect(publicKey).toHaveLength(65);
    expect(publicKey[0]).toBe(4);
    const sealed = await hpkeSeal(publicKey, bytes('share'), { info: bytes('i'), aad: bytes('a') });
    expect(await hpkeOpen(pair, sealed, { info: bytes('i'), aad: bytes('a') })).toEqual(bytes('share'));
    await expect(hpkeOpen(pair, sealed, { info: bytes('x'), aad: bytes('a') })).rejects.toThrow();
  });

  it('frames the encapsulated key first', async () => {
    const pair = await hpkeDeriveKeyPair(key());
    const sealed = await hpkeSeal(await hpkeSerializePublicKey(pair.publicKey), bytes('share'), ctx);
    expect(sealed).toHaveLength(HPKE_ENC_BYTES + 5 + 16);
    expect(sealed[0]).toBe(4);
  });

  it('derives the same key from the same input, and only the right key opens', async () => {
    const ikm = key();
    const [a, b, other] = await Promise.all([
      hpkeDeriveKeyPair(ikm),
      hpkeDeriveKeyPair(ikm),
      hpkeDeriveKeyPair(key()),
    ]);
    const publicKey = await hpkeSerializePublicKey(a.publicKey);
    expect(await hpkeSerializePublicKey(b.publicKey)).toEqual(publicKey);
    const sealed = await hpkeSeal(publicKey, bytes('share'), ctx);
    expect(await hpkeOpen(b, sealed, ctx)).toEqual(bytes('share'));
    await expect(hpkeOpen(other, sealed, ctx)).rejects.toThrow();
  });
});

describe('XOR combine', () => {
  it('recovers K from its two halves', () => {
    const k = key();
    const pub = key();
    const priv = xorCombine(k, pub);
    expect(xorCombine(pub, priv)).toEqual(k);
  });

  it('rejects the wrong length', () => {
    expect(() => xorCombine(new Uint8Array(31), new Uint8Array(32))).toThrow(RangeError);
  });
});

/** Real quicknet round 1000, signed by the real network, so these run offline. */
const beacon = {
  round: 1000,
  randomness: 'fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd',
  signature:
    'b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39',
};

function offlineQuicknet(): ChainClient {
  const info: ChainInfo = defaultChainInfo;
  return {
    options: { disableBeaconVerification: false, noCache: true },
    chain: () => ({ baseUrl: 'offline', info: () => Promise.resolve(info) }),
    latest: () => Promise.resolve(beacon),
    get: (round) => {
      if (round !== beacon.round) throw new Error('no beacon for this round');
      return Promise.resolve(beacon);
    },
  };
}

/** Sealing is the TEE's job, so the package has no encrypt. Tests seal with tlock-js directly. */
const seal = (round: number, plaintext: Uint8Array, client: ChainClient) =>
  timelockEncrypt(round, TlockBuffer.from(plaintext), client);

describe('timelock', () => {
  it('uses the chain tlock-js knows as quicknet', () => {
    expect(defaultChainInfo.hash).toBe(drand.chainHash);
    expect(defaultChainInfo.public_key).toBe(drand.publicKey);
    expect(defaultChainInfo.schemeID).toBe(drand.scheme);
    expect(defaultChainInfo.period).toBe(drand.periodSeconds);
    expect(defaultChainInfo.genesis_time).toBe(drand.genesisTime);
    expect(quicknetClient().chain().baseUrl).toContain(drand.chainHash);
  });

  it('round-trips against a real quicknet beacon', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = offlineQuicknet();
    const k = key();
    const armoured = await seal(beacon.round, k, client);
    expect(armoured).toContain('BEGIN AGE ENCRYPTED FILE');
    expect(await timelockDecrypt(armoured, client)).toEqual(k);
    log.mockRestore();
  });

  it('fails before the round is due', async () => {
    const client = offlineQuicknet();
    const future = Math.ceil((Date.now() / 1000 - roundTimeSeconds(1)) / drand.periodSeconds) + 10_000;
    const armoured = await seal(future, key(), client);
    await expect(timelockDecrypt(armoured, client)).rejects.toThrow('too early');
  });

  it('rejects a forged beacon', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = offlineQuicknet();
    const armoured = await seal(beacon.round, key(), client);
    const forged = { ...client, get: () => Promise.resolve({ ...beacon, signature: `a4${beacon.signature.slice(2)}` }) };
    await expect(timelockDecrypt(armoured, forged)).rejects.toThrow();
    log.mockRestore();
  });
});

describe('TEE signatures', () => {
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const curve = { name: 'ECDSA', namedCurve: 'P-256' };
  const sign = { name: 'ECDSA', hash: 'SHA-256' };

  async function signed(message: Uint8Array) {
    const pair = await globalThis.crypto.subtle.generateKey(curve, true, ['sign', 'verify']);
    const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
    const raw = new Uint8Array(
      await globalThis.crypto.subtle.sign(sign, pair.privateKey, new Uint8Array(message)),
    );
    const s = BigInt(`0x${Buffer.from(raw.subarray(32)).toString('hex')}`);
    const flip = (value: bigint) =>
      new Uint8Array(Buffer.from((order - value).toString(16).padStart(64, '0'), 'hex'));
    const high = s > order / 2n;
    const low = raw.slice();
    const other = raw.slice();
    (high ? low : other).set(flip(s), 32);
    return { publicKey, low, highS: other };
  }

  it('accepts a low-s signature and rejects the high-s form', async () => {
    const message = bytes('message');
    const { publicKey, low, highS } = await signed(message);
    expect(await verifyTeeSignature(publicKey, low, message)).toBe(true);
    expect(await verifyTeeSignature(publicKey, highS, message)).toBe(false);
  });

  it('rejects another message or a malformed signature', async () => {
    const { publicKey, low } = await signed(bytes('message'));
    expect(await verifyTeeSignature(publicKey, low, bytes('other'))).toBe(false);
    expect(await verifyTeeSignature(publicKey, low.subarray(1), bytes('message'))).toBe(false);
  });
});

describe('purpose helpers', () => {
  const kem = async () => {
    const pair = await hpkeDeriveKeyPair(key());
    return { pair, publicKey: await hpkeSerializePublicKey(pair.publicKey) };
  };

  it('takes info from constants.json and aad from the examId', () => {
    for (const purpose of ['question', 'share', 'release', 'keyPriv'] as const) {
      const { info, aad } = hpkeContext(purpose, examId);
      expect(new TextDecoder().decode(info)).toBe(constants.crypto.hpke.info[purpose]);
      expect(aad).toEqual(examId);
    }
    expect(() => hpkeContext('share', new Uint8Array(31))).toThrow(RangeError);
  });

  it('seals a question padded to questionBytes, and only the question purpose opens it', async () => {
    const { pair, publicKey } = await kem();
    const sealed = await sealQuestion(publicKey, examId, { topic: 'algebra', text: 'x?' });
    expect(sealed).toHaveLength(HPKE_ENC_BYTES + constants.padding.questionBytes + 16);
    const padded = await hpkeOpen(pair, sealed, hpkeContext('question', examId));
    expect(parseQuestion(unpadQuestion(padded))).toEqual({ topic: 'algebra', text: 'x?' });
    await expect(hpkeOpen(pair, sealed, hpkeContext('share', examId))).rejects.toThrow();
    await expect(hpkeOpen(pair, sealed, hpkeContext('question', new Uint8Array(32)))).rejects.toThrow();
  });

  it('seals the release plaintext for the TEE', async () => {
    const { pair, publicKey } = await kem();
    const release = {
      share: bytes('share'),
      signature: bytes('sig'),
      authenticatorData: bytes('auth'),
      clientDataJSON: bytes('{}'),
    };
    const sealed = await sealRelease(publicKey, examId, release);
    const plaintext = await hpkeOpen(pair, sealed, hpkeContext('release', examId));
    expect(decodeRelease(plaintext)).toEqual(release);
  });

  it('opens a share only with the share purpose and the right exam', async () => {
    const { pair, publicKey } = await kem();
    const sealed = await hpkeSeal(publicKey, bytes('share'), hpkeContext('share', examId));
    expect(await openShare(pair, examId, sealed)).toEqual(bytes('share'));
    await expect(openShare(pair, new Uint8Array(32), sealed)).rejects.toThrow();
    await expect(openKeyPriv(pair, examId, sealed)).rejects.toThrow();
  });

  it('opens keyPriv and insists on 32 bytes', async () => {
    const { pair, publicKey } = await kem();
    const kPriv = key();
    expect(await openKeyPriv(pair, examId, await hpkeSeal(publicKey, kPriv, hpkeContext('keyPriv', examId)))).toEqual(kPriv);
    const short = await hpkeSeal(publicKey, new Uint8Array(16), hpkeContext('keyPriv', examId));
    await expect(openKeyPriv(pair, examId, short)).rejects.toThrow('32 bytes');
  });

  it('opens the paper file: K over the seed then the padded paper, aad the examId', async () => {
    const k = key();
    const seed = key();
    const paper = bytes('{"examId":"0x","questions":[]}');
    const file = await aesGcmEncrypt(k, concatBytes(seed, padPaper(paper)), examId);
    expect(await openPaperFile(k, examId, file)).toEqual({ seed, paper });
    await expect(openPaperFile(k, new Uint8Array(32), file)).rejects.toThrow();
    const short = await aesGcmEncrypt(k, seed, examId);
    await expect(openPaperFile(k, examId, short)).rejects.toThrow('padded paper');
  });
});
