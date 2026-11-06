import type { TokenVerdict } from '@paperseal/attestation';
import { hpkeContext, hpkeDeriveKeyPair, hpkeOpen, hpkeSerializePublicKey } from '@paperseal/crypto';
import type { Keys } from '@paperseal/keys';
import {
  approvedListHash,
  criteriaHash,
  encodeCriteria,
  encodeMessage,
  examIdFromName,
  fromHex,
  hashMessage,
  inviteTag,
  questionHash,
  setterOwner,
  toHex,
  type Criteria,
  type Hex,
} from '@paperseal/protocol';
import { TeeApiError, type StatusResponse } from '@paperseal/tee-client';
import { vi } from 'vitest';

import type { SetterEnv } from './session';

/** Stubs for the TEE, the chain and the keys. Used only by tests. */

export const examId = examIdFromName('physics-2027');
export const registryAddress = '0x00000000000000000000000000000000000000aa' as Hex;
export const criteria: Criteria = {
  maxSetterPercent: 50,
  minBankMultiple: 2,
  topics: [
    { name: 'Mechanics', questions: 2 },
    { name: 'Optics', questions: 1 },
  ],
};
export const passkeyPublicKey = toHex(Uint8Array.from([4, ...Array.from({ length: 64 }, (_, i) => i + 1)]));
export const credentialId = '0x0102030405' as Hex;

const P256_HALF_ORDER = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n;

/** A P-256 key standing in for a TEE signing instance. Signs with low s, as the TEE does. */
export async function makeSigner() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const sign = async (message: Uint8Array): Promise<Hex> => {
    for (;;) {
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, message as BufferSource),
      );
      let s = 0n;
      for (const byte of sig.subarray(32)) s = (s << 8n) | BigInt(byte);
      if (s <= P256_HALF_ORDER) return toHex(sig);
    }
  };
  return { publicKey: toHex(publicKey), sign };
}
export type Signer = Awaited<ReturnType<typeof makeSigner>>;

export const trustedVerdict: TokenVerdict = {
  trusted: true,
  signature: { ok: true },
  instanceKey: { ok: true },
  claims: [],
};

export interface World {
  env: SetterEnv;
  tee: NonNullable<SetterEnv['tee']>;
  chain: NonNullable<SetterEnv['chain']>;
  signer: Signer;
  encryption: CryptoKeyPair;
  encryptionPublicKey: Hex;
  /** Passkey signatures requested, as the message each one covered. */
  signed: Uint8Array[];
  /** The question plaintext the TEE opened, in the order sent. */
  opened: Uint8Array[];
  teeQuestion: ReturnType<typeof vi.fn>;
  stage: { current: StatusResponse['stage'] };
  /** What the chain stores as the list hash. */
  chainListHash: { current: Hex };
  build: { current: { instancePublicKey: Hex } | null };
  verifyToken: ReturnType<typeof vi.fn>;
}

export interface WorldOptions {
  /** Use the app's real `checkToken` with a token that cannot pass. */
  realAttestation?: boolean;
  chainListHashOverride?: Hex;
  /** A different key signs question receipts than the instance key the TEE attested. */
  receiptSigner?: Signer;
  /** Receipts echo a different question hash. */
  wrongReceiptHash?: boolean;
}

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const signer = await makeSigner();
  const encryption = await hpkeDeriveKeyPair(crypto.getRandomValues(new Uint8Array(32)));
  const encryptionPublicKey = toHex(await hpkeSerializePublicKey(encryption.publicKey));
  const encodedCriteria = encodeCriteria(criteria);
  const entries = toHex(Uint8Array.from([1, 2, 3, 4]));
  const listHash = toHex(approvedListHash(fromHex(examId), fromHex(entries)));
  const chainListHash = { current: options.chainListHashOverride ?? listHash };
  const stage: World['stage'] = { current: 'submit' };
  const signed: Uint8Array[] = [];
  const opened: Uint8Array[] = [];
  const build: World['build'] = { current: null };

  const instanceKeySignature = await signer.sign(
    encodeMessage('instanceKey', { examId: fromHex(examId), encryptionPublicKey: fromHex(encryptionPublicKey) }),
  );
  const approvedListSignature = await signer.sign(
    encodeMessage('approvedList', { examId: fromHex(examId), entries: fromHex(entries) }),
  );
  const receiptSigner = options.receiptSigner ?? signer;

  const teeQuestion = vi.fn(async (body: { ciphertext: Hex; passkeyPublicKey: Hex }) => {
    // The TEE opens a question with `examId || passkeyPublicKey` as aad, so a ciphertext sealed for
    // another passkey is refused here as it is by the real TEE.
    try {
      opened.push(await hpkeOpen(encryption, fromHex(body.ciphertext), hpkeContext('question', fromHex(examId), fromHex(body.passkeyPublicKey))));
    } catch {
      throw new TeeApiError(400, 'decryption_failed', 'the question did not decrypt');
    }
    const hash = questionHash(fromHex(body.ciphertext));
    return {
      questionHash: toHex(options.wrongReceiptHash ? new Uint8Array(32).fill(9) : hash),
      teeSignature: await receiptSigner.sign(
        encodeMessage('questionReceipt', {
          examId: fromHex(examId),
          passkeyPublicKey: fromHex(passkeyPublicKey),
          questionHash: hash,
        }),
      ),
    };
  });

  const fakeToken = `${b64url({ alg: 'ES256' })}.${b64url({})}.c2ln`;
  const verifyToken = vi.fn(() => Promise.resolve(trustedVerdict));
  const keys: Pick<Keys, 'register' | 'sign'> = {
    register: vi.fn((options: { inviteSecret: Uint8Array }) =>
      Promise.resolve({
        credentialId: fromHex(credentialId),
        owner: setterOwner(fromHex(passkeyPublicKey)),
        request: { passkeyPublicKey, inviteTag: toHex(inviteTag(options.inviteSecret, fromHex(passkeyPublicKey))) },
      } as never),
    ),
    sign: vi.fn((_id: Uint8Array, message: Uint8Array) => {
      signed.push(message);
      return Promise.resolve({
        signature: Uint8Array.from([7, 7]),
        authenticatorData: Uint8Array.from([8, 8]),
        clientDataJSON: Uint8Array.from([9, 9]),
      });
    }),
  };

  const env: SetterEnv = {
    examId,
    registryAddress,
    tee: {
      attestation: () =>
        Promise.resolve({
          token: fakeToken,
          instancePublicKey: signer.publicKey,
          encryptionPublicKey,
          instanceKeySignature,
        }),
      status: () =>
        Promise.resolve({
          stage: stage.current,
          questionCount: 0,
          approvedList: { examId, entries, hash: listHash, teeSignature: approvedListSignature },
          release: { released: [], required: 8 },
        }),
      registerChallenge: () => Promise.resolve({ challenge: toHex(new Uint8Array(80).fill(6)) }),
      register: () => Promise.resolve({}) as never,
      // Longer than 32 bytes, like the TEE's: nothing may assume a challenge width.
      questionChallenge: () => Promise.resolve({ challenge: toHex(new Uint8Array(80).fill(5)) }),
      question: teeQuestion as never,
    },
    chain: {
      getExam: () =>
        Promise.resolve({
          commitHash: `0x${'a'.repeat(40)}`,
          imageDigest: `0x${'b'.repeat(64)}`,
          createdAt: 1n,
          createdBlock: 1n,
          settings: {
            examId,
            examStart: 2_000_000_000n,
            delta: 600n,
            lockRound: 100n,
            unlockRound: 200n,
            endRound: 300n,
            criteriaHash: toHex(criteriaHash(encodedCriteria)),
            rpcHost: 'rpc.example.org',
          },
        }),
      getCriteria: () => Promise.resolve(toHex(encodedCriteria)),
      getApprovedList: () =>
        Promise.resolve({ examId, listHash: chainListHash.current, postedAt: 1n, postedBlock: 1n }),
      getBuild: () =>
        Promise.resolve(build.current ? ({ ...build.current, examId } as never) : null),
    } as unknown as NonNullable<SetterEnv['chain']>,
    keys: () => keys,
    policy: { storageBucket: 'test-bucket' },
    statusPollMs: 10,
    buildPollMs: 10,
    ...(options.realAttestation ? {} : { verifyToken: verifyToken as never }),
  };
  return { env, tee: env.tee as NonNullable<SetterEnv['tee']>, chain: env.chain as NonNullable<SetterEnv['chain']>, signer, encryption, encryptionPublicKey, signed, opened, teeQuestion, stage, chainListHash, build, verifyToken };
}

/** A receipt the world's TEE really signed, as a past seal would have left in storage. */
export async function signedReceipt(world: World, fill: number, signer: Signer = world.signer) {
  const hash = new Uint8Array(32).fill(fill);
  return {
    questionHash: toHex(hash),
    instancePublicKey: signer.publicKey,
    teeSignature: await signer.sign(
      encodeMessage('questionReceipt', {
        examId: fromHex(examId),
        passkeyPublicKey: fromHex(passkeyPublicKey),
        questionHash: hash,
      }),
    ),
    sealedAt: 0,
  };
}

/** The hash a passkey must sign for a question submission. */
export const submissionDigest = (challenge: Hex, hash: Uint8Array) =>
  hashMessage('questionSubmission', { examId: fromHex(examId), challenge: fromHex(challenge), questionHash: hash });

/** The body of the nth question POST. */
export function postedBody(world: World, n = 0): { ciphertext: Hex; challenge: Hex } {
  const call = world.teeQuestion.mock.calls[n] as [{ ciphertext: Hex; challenge: Hex }] | undefined;
  if (!call) throw new Error(`no question POST number ${String(n)}`);
  return call[0];
}
