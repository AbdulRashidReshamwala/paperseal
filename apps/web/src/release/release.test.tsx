import { createHash } from 'node:crypto';

import type { TokenVerdict } from '@paperseal/attestation';
import { hpkeContext, hpkeDeriveKeyPair, hpkeOpen } from '@paperseal/crypto';
import {
  approvedListHash,
  decodeRelease,
  encodeApprovedList,
  encodeMessage,
  fromHex,
  hashMessage,
  roles,
  toHex,
  type ApprovedListEntry,
  type Hex,
} from '@paperseal/protocol';
import { RELEASE_NOT_OPEN_MESSAGE, TeeApiError } from '@paperseal/tee-client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { releaseSteps, runRelease, type ReleaseContext } from './flow';
import { ReleaseScreen } from './ReleaseScreen';

const examId: Hex = `0x${'11'.repeat(32)}`;
const share = () => new Uint8Array([1, 2, 3, 4]);
const key = (seed: number) => new Uint8Array([4, ...new Uint8Array(64).fill(seed)]);
const sha = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());

/** Longer than 32 bytes: the TEE's challenge carries an expiry and a tag, so no width is assumed. */
const challenge = `0x${'ab'.repeat(80)}`;

const trusted = { trusted: true, signature: { ok: true }, instanceKey: { ok: true }, claims: [] } as TokenVerdict;

/** 3 neutral parties and 7 centre key holders. Entry 0 is the holder under test. */
const holders: ApprovedListEntry[] = Array.from({ length: 10 }, (_, i) => ({
  role: i < 3 ? roles.neutral : roles.centreKeyHolder,
  passkeyPublicKey: key(10 + i),
  derivedPublicKey: key(50 + i),
  owner: `holder-${String(i)}`,
}));
const entries = toHex(encodeApprovedList(holders));
const listHash: Hex = toHex(approvedListHash(fromHex(examId), fromHex(entries)));
const own = holders[0] as ApprovedListEntry;

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

  const shareName = `shares/${toHex(own.derivedPublicKey)}.bin`;
  const sealedShare = new Uint8Array([9, 9, 9]);
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      examId,
      files: [
        {
          name: shareName,
          sha256: toHex(sha(sealedShare)),
          recipient: toHex(own.derivedPublicKey),
          shareHash: toHex(hashMessage('shareHash', { share: share() })),
        },
      ],
    }),
  );
  const files = new Map<string, Uint8Array>([
    ['manifest.json', manifestBytes],
    [shareName, sealedShare],
  ]);

  const context = {
    examId,
    credentialId: new Uint8Array([1]),
    passkeyPublicKey: toHex(own.passkeyPublicKey),
    derivedPublicKey: toHex(own.derivedPublicKey),
    keys: {
      releaseShare: vi.fn((_id: Uint8Array, _examId: Uint8Array, _message: Uint8Array, _sealed: Uint8Array) =>
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
      attestation: vi.fn(() =>
        Promise.resolve({
          token: 'token',
          instancePublicKey: toHex(publicKey),
          encryptionPublicKey: toHex(publicKey),
          instanceKeySignature: '0x00' as Hex,
        }),
      ),
      status: vi.fn(() =>
        Promise.resolve({
          stage: 'unlock' as const,
          questionCount: 0,
          approvedList: { examId, entries, hash: listHash, teeSignature: toHex(signature) },
          release: { released: [] as Hex[], required: 8 },
        }),
      ),
      releaseChallenge: vi.fn(() => Promise.resolve({ challenge: challenge as Hex })),
      releaseShare: vi.fn(() => Promise.resolve({})),
    },
    checkAttestation: vi.fn((_attestation: unknown) => Promise.resolve(trusted)),
    readOnChainListHash: vi.fn(() => Promise.resolve(listHash)),
    readBuild: vi.fn(() => Promise.resolve({ storageManifestHash: toHex(sha(manifestBytes)), paperHash: `0x${'00'.repeat(32)}` as Hex })),
    fetchFile: vi.fn((name: string) => {
      const found = files.get(name);
      return found ? Promise.resolve(found) : Promise.reject(new Error(`no ${name}`));
    }),
  } satisfies ReleaseContext;
  return { context, hpkeKey, files, sealedShare, shareName, publicKey };
}

describe('runRelease', () => {
  it('walks every step in order and submits', async () => {
    const { context } = await setup();
    const seen: string[] = [];
    await runRelease({ ...context, onStep: (step) => seen.push(step) });
    expect(seen).toEqual([...releaseSteps]);
    expect(seen).not.toContain('timelock');
    expect(context.tee.releaseShare).toHaveBeenCalledOnce();
    expect(context.keys.releaseShare).toHaveBeenCalledOnce();
  });

  it('seals the release to the encryption key, with the share, signature and WebAuthn data', async () => {
    const { context, hpkeKey } = await setup();
    await runRelease(context);
    const [request] = context.tee.releaseShare.mock.calls[0] as unknown as [{ sealed: Hex; passkeyPublicKey: Hex; challenge: Hex }];
    expect(request.passkeyPublicKey).toBe(toHex(own.passkeyPublicKey));
    expect(request.challenge).toBe(challenge);
    const opened = decodeRelease(await hpkeOpen(hpkeKey, fromHex(request.sealed), hpkeContext('release', fromHex(examId))));
    expect(opened.share).toEqual(share());
    expect(opened.signature).toHaveLength(70);
    expect(opened.authenticatorData).toHaveLength(37);
    const other = await hpkeDeriveKeyPair(new Uint8Array(32).fill(2));
    await expect(hpkeOpen(other, fromHex(request.sealed), hpkeContext('release', fromHex(examId)))).rejects.toThrow();
    // Wrong purpose or exam cannot open it either.
    await expect(hpkeOpen(hpkeKey, fromHex(request.sealed), hpkeContext('share', fromHex(examId)))).rejects.toThrow();
  });

  it('seals to encryptionPublicKey, not instancePublicKey', async () => {
    const { context, hpkeKey, publicKey } = await setup();
    const other = await instanceKey();
    context.tee.attestation.mockResolvedValue({
      token: 'token',
      instancePublicKey: toHex(publicKey),
      encryptionPublicKey: toHex(other.publicKey),
      instanceKeySignature: '0x00',
    });
    await runRelease(context);
    const [request] = context.tee.releaseShare.mock.calls[0] as unknown as [{ sealed: Hex }];
    const info = hpkeContext('release', fromHex(examId));
    await expect(hpkeOpen(hpkeKey, fromHex(request.sealed), info)).rejects.toThrow();
    await expect(hpkeOpen(other.hpkeKey, fromHex(request.sealed), info)).resolves.toBeDefined();
  });

  it('says plainly that release is not open yet when the TEE refuses the challenge before the unlock round', async () => {
    const { context } = await setup();
    context.tee.releaseChallenge.mockRejectedValue(new TeeApiError(425, 'too_early', 'the unlock round is not published yet'));
    await expect(runRelease(context)).rejects.toMatchObject({ step: 'challenge', message: RELEASE_NOT_OPEN_MESSAGE });
    expect(context.keys.releaseShare).not.toHaveBeenCalled();
    expect(context.tee.releaseShare).not.toHaveBeenCalled();
  });

  it('sends nothing if the attestation is not trusted', async () => {
    const { context } = await setup();
    context.checkAttestation.mockResolvedValue({ ...trusted, trusted: false } as TokenVerdict);
    await expect(runRelease(context)).rejects.toMatchObject({ step: 'attest' });
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

  it('refuses a key that is not a key holder on the list', async () => {
    const { context } = await setup();
    await expect(runRelease({ ...context, passkeyPublicKey: toHex(key(99)) })).rejects.toMatchObject({ step: 'listHash' });
    expect(context.keys.releaseShare).not.toHaveBeenCalled();
  });

  it('refuses a manifest that does not match the Build', async () => {
    const { context } = await setup();
    context.readBuild.mockResolvedValue({ storageManifestHash: `0x${'44'.repeat(32)}`, paperHash: `0x${'00'.repeat(32)}` });
    await expect(runRelease(context)).rejects.toMatchObject({ step: 'fetch' });
    expect(context.keys.releaseShare).not.toHaveBeenCalled();
  });

  it('refuses a share file that does not match the manifest', async () => {
    const { context, files, shareName } = await setup();
    files.set(shareName, new Uint8Array([7, 7, 7]));
    await expect(runRelease(context)).rejects.toMatchObject({ step: 'fetch' });
    expect(context.keys.releaseShare).not.toHaveBeenCalled();
    expect(context.tee.releaseChallenge).not.toHaveBeenCalled();
  });

  it('touches the key once, signing only examId and the challenge over the downloaded share', async () => {
    const { context, sealedShare } = await setup();
    await runRelease(context);
    expect(context.keys.releaseShare).toHaveBeenCalledOnce();
    const [credentialId, id, digest, sealed] = context.keys.releaseShare.mock.calls[0] as unknown as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    expect(credentialId).toEqual(new Uint8Array([1]));
    expect(id).toEqual(fromHex(examId));
    expect(sealed).toEqual(sealedShare);
    expect(digest).toEqual(hashMessage('shareRelease', { examId: fromHex(examId), challenge: fromHex(challenge) }));
  });

  it('does not send a share whose hash differs from the manifest', async () => {
    const { context } = await setup();
    context.keys.releaseShare.mockResolvedValue({
      share: new Uint8Array([5, 5]),
      signature: { signature: new Uint8Array(70), authenticatorData: new Uint8Array(37), clientDataJSON: new Uint8Array(2) },
    });
    await expect(runRelease(context)).rejects.toMatchObject({ step: 'release' });
    expect(context.tee.releaseShare).not.toHaveBeenCalled();
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
