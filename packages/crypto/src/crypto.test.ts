import { drand, roundTimeSeconds } from '@paperseal/protocol';
import { defaultChainInfo, type ChainClient, type ChainInfo } from 'tlock-js';
import { describe, expect, it, vi } from 'vitest';

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  HPKE_ENC_BYTES,
  hpkeDeriveKeyPair,
  hpkeOpen,
  hpkeSeal,
  hpkeSerializePublicKey,
  quicknetClient,
  timelockDecrypt,
  timelockEncrypt,
  verifyTeeSignature,
  xorCombine,
} from './index';

const bytes = (text: string) => new TextEncoder().encode(text);
const key = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

describe('AES-256-GCM', () => {
  it('round-trips with and without AAD', async () => {
    const k = key();
    expect(await aesGcmDecrypt(k, await aesGcmEncrypt(k, bytes('paper')))).toEqual(bytes('paper'));
    const sealed = await aesGcmEncrypt(k, bytes('paper'), bytes('aad'));
    expect(await aesGcmDecrypt(k, sealed, bytes('aad'))).toEqual(bytes('paper'));
    await expect(aesGcmDecrypt(k, sealed, bytes('other'))).rejects.toThrow();
  });

  it('rejects tampering, a wrong key and a short key', async () => {
    const k = key();
    const sealed = await aesGcmEncrypt(k, bytes('paper'));
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    await expect(aesGcmDecrypt(k, tampered)).rejects.toThrow();
    await expect(aesGcmDecrypt(key(), sealed)).rejects.toThrow();
    await expect(aesGcmEncrypt(new Uint8Array(16), bytes('x'))).rejects.toThrow(RangeError);
  });
});

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
    const sealed = await hpkeSeal(await hpkeSerializePublicKey(pair.publicKey), bytes('share'));
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
    const sealed = await hpkeSeal(publicKey, bytes('share'));
    expect(await hpkeOpen(b, sealed)).toEqual(bytes('share'));
    await expect(hpkeOpen(other, sealed)).rejects.toThrow();
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
    const armoured = await timelockEncrypt(beacon.round, k, client);
    expect(armoured).toContain('BEGIN AGE ENCRYPTED FILE');
    expect(await timelockDecrypt(armoured, client)).toEqual(k);
    log.mockRestore();
  });

  it('fails before the round is due', async () => {
    const client = offlineQuicknet();
    const future = Math.ceil((Date.now() / 1000 - roundTimeSeconds(1)) / drand.periodSeconds) + 10_000;
    const armoured = await timelockEncrypt(future, key(), client);
    await expect(timelockDecrypt(armoured, client)).rejects.toThrow('too early');
  });

  it('rejects a forged beacon', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const client = offlineQuicknet();
    const armoured = await timelockEncrypt(beacon.round, key(), client);
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
