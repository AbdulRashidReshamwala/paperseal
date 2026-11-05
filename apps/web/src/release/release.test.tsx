import { hpkeDeriveKeyPair, hpkeOpen } from '@paperseal/crypto';
import { approvedListHash, encodeMessage, hashMessage, fromHex, toHex, type Hex } from '@paperseal/protocol';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { releaseSteps, runRelease, type ReleaseContext } from './flow';
import { ReleaseScreen } from './ReleaseScreen';

const examId: Hex = `0x${'11'.repeat(32)}`;
const entries: Hex = '0x1234';
const listHash: Hex = toHex(approvedListHash(fromHex(examId), fromHex(entries)));
const share = () => new Uint8Array([1, 2, 3, 4]);

/** One P-256 instance key, used for ECDSA and for HPKE, as the README describes. */
async function instanceKey() {
  const subtle = globalThis.crypto.subtle;
  const ecdsa = { name: 'ECDSA', namedCurve: 'P-256' };
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
  const pair = await subtle.generateKey(ecdsa, true, ['sign', 'verify']);
  const { key_ops: _privateOps, ...privateJwk } = await subtle.exportKey('jwk', pair.privateKey);
  const { key_ops: _publicOps, ...publicJwk } = await subtle.exportKey('jwk', pair.publicKey);
  const hpkeKey: CryptoKeyPair = {
    privateKey: await subtle.importKey('jwk', privateJwk, ecdh, true, ['deriveBits']),
    publicKey: await subtle.importKey('jwk', publicJwk, ecdh, true, []),
  };
  return { pair, hpkeKey, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

async function setup() {
  const { pair, hpkeKey, publicKey } = await instanceKey();
  let signature = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new Uint8Array(encodeMessage('approvedList', { examId: fromHex(examId), entries: fromHex(entries) })),
    ),
  );
  // Normalise to low s, as the TEE must.
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const s = BigInt(toHex(signature.subarray(32)));
  if (s > order / 2n) {
    signature = signature.slice();
    signature.set(fromHex(`0x${(order - s).toString(16).padStart(64, '0')}`), 32);
  }

  const context = {
    examId,
    holderId: 'holder-1',
    credentialId: new Uint8Array([1]),
    keys: {
      releaseShare: vi.fn((_id: Uint8Array, _message: Uint8Array, _sealed: Uint8Array) =>
        Promise.resolve({
          share: share(),
          signature: {
            signature: new Uint8Array(70),
            authenticatorData: new Uint8Array(37),
            clientDataJSON: new Uint8Array(2),
          },
        }),
      ),
    },
    tee: {
      attestation: vi.fn(() => Promise.resolve({ token: 'token', instancePublicKey: toHex(publicKey) })),
      status: vi.fn(() =>
        Promise.resolve({
          stage: 'unlock' as const,
          approvedList: { examId, entries, hash: listHash, teeSignature: toHex(signature) },
          release: { holders: [], required: 8 },
        }),
      ),
      releaseChallenge: vi.fn(() => Promise.resolve({ challenge: '0xabcd' as Hex })),
      releaseShare: vi.fn(() => Promise.resolve({})),
    },
    fetchEncryptedShare: vi.fn(() => Promise.resolve('armoured')),
    timelockDecrypt: vi.fn(() => Promise.resolve(new Uint8Array(1))),
    verifyAttestation: vi.fn(() => Promise.resolve()),
    readOnChainListHash: vi.fn(() => Promise.resolve(listHash)),
  } satisfies ReleaseContext;
  return { context, hpkeKey };
}

describe('runRelease', () => {
  it('walks every step in order and submits', async () => {
    const { context } = await setup();
    const seen: string[] = [];
    await runRelease({ ...context, onStep: (step) => seen.push(step) });
    expect(seen).toEqual([...releaseSteps]);
    expect(context.tee.releaseShare).toHaveBeenCalledOnce();
    expect(context.keys.releaseShare).toHaveBeenCalledOnce();
  });

  it('seals the share so only the attested key can read it', async () => {
    const { context, hpkeKey } = await setup();
    await runRelease(context);
    const [request] = context.tee.releaseShare.mock.calls[0] as unknown as [{ sealed: Hex }];
    const opened = await hpkeOpen(hpkeKey, fromHex(request.sealed));
    expect(opened.subarray(0, 8)).toEqual(new Uint8Array([0, 0, 0, 4, 1, 2, 3, 4]));
    const other = await hpkeDeriveKeyPair(new Uint8Array(32).fill(2));
    await expect(hpkeOpen(other, fromHex(request.sealed))).rejects.toThrow();
  });

  it('sends nothing if attestation fails', async () => {
    const { context } = await setup();
    context.verifyAttestation.mockRejectedValue(new Error('not trusted'));
    await expect(runRelease(context)).rejects.toThrow('not trusted');
    expect(context.keys.releaseShare).not.toHaveBeenCalled();
    expect(context.tee.releaseChallenge).not.toHaveBeenCalled();
    expect(context.tee.releaseShare).not.toHaveBeenCalled();
  });

  it('sends nothing if the list hash differs from the chain', async () => {
    const { context } = await setup();
    context.readOnChainListHash.mockResolvedValue(`0x${'33'.repeat(32)}`);
    await expect(runRelease(context)).rejects.toMatchObject({ step: 'listHash' });
    expect(context.keys.releaseShare).not.toHaveBeenCalled();
    expect(context.tee.releaseShare).not.toHaveBeenCalled();
  });

  it('sends nothing if the TEE list signature is invalid', async () => {
    const { context } = await setup();
    const status = await context.tee.status();
    context.tee.status.mockResolvedValue({
      ...status,
      approvedList: { examId, entries, hash: listHash, teeSignature: `0x${'01'.repeat(64)}` },
    });
    await expect(runRelease(context)).rejects.toMatchObject({ step: 'listHash' });
    expect(context.keys.releaseShare).not.toHaveBeenCalled();
    expect(context.tee.releaseShare).not.toHaveBeenCalled();
  });

  it('sends nothing if the signed hash does not cover the signed list', async () => {
    const { context } = await setup();
    const status = await context.tee.status();
    context.tee.status.mockResolvedValue({
      ...status,
      approvedList: { ...status.approvedList, entries: '0x5678' },
    });
    await expect(runRelease(context)).rejects.toMatchObject({ step: 'listHash' });
    expect(context.tee.releaseShare).not.toHaveBeenCalled();
  });

  it('touches the key once, signing only examId and the challenge over the timelock-opened share', async () => {
    const { context } = await setup();
    await runRelease(context);
    expect(context.keys.releaseShare).toHaveBeenCalledOnce();
    const [credentialId, digest, sealedShare] = context.keys.releaseShare.mock.calls[0] as unknown as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    expect(credentialId).toEqual(new Uint8Array([1]));
    expect(sealedShare).toEqual(new Uint8Array(1));
    expect(digest).toEqual(
      hashMessage('shareRelease', { examId: fromHex(examId), challenge: fromHex('0xabcd') }),
    );
  });

  it('sends nothing if the one key touch fails', async () => {
    const { context } = await setup();
    context.keys.releaseShare.mockRejectedValue(new Error('cancelled'));
    await expect(runRelease(context)).rejects.toThrow('cancelled');
    expect(context.tee.releaseShare).not.toHaveBeenCalled();
  });

  it('wipes the share buffer on failure', async () => {
    const { context } = await setup();
    const buffer = share();
    context.keys.releaseShare.mockResolvedValue({
      share: buffer,
      signature: { signature: new Uint8Array(70), authenticatorData: new Uint8Array(37), clientDataJSON: new Uint8Array(2) },
    });
    context.tee.releaseShare.mockRejectedValue(new Error('no'));
    await expect(runRelease(context)).rejects.toThrow('no');
    expect(buffer).toEqual(new Uint8Array(4));
  });
});

describe('ReleaseScreen', () => {
  it('stays disabled and shows what is missing without a context', () => {
    const html = renderToString(
      <ReleaseScreen prerequisites={[{ label: 'TEE connected', met: false }]} context={null} />,
    );
    expect(html).toContain('TEE connected');
    expect(html).toContain('Not ready');
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
