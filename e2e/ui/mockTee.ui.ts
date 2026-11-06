import { checkToken, type ExpectedClaims } from '@paperseal/attestation';
import { createExamRegistry } from '@paperseal/chain';
import { attestation as attestationSpec, fromHex, type Hex } from '@paperseal/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startChain, type Chain } from '../src/chain';
import { startMockTee, type MockTee } from '../mock/mockTee';
import { makeMockPki, type MockPki } from '../mock/pki';
import { publishDirect, timings, type PublishedHere } from './chainkit';

/*
 * A quick check of the mock sealed machine's attestation, with no browser. The token must pass every
 * claim check of @paperseal/attestation against the exam on the chain when the mock root is trusted,
 * and must fail when it is not, which is what every app does outside its mock mode.
 */

let chain: Chain;
let pki: MockPki;
let tee: MockTee;
let exam: PublishedHere;
const storage = new Map<string, Uint8Array>();

beforeAll(async () => {
  chain = await startChain();
  pki = makeMockPki();
  const registry = createExamRegistry({ address: chain.registry, rpcUrl: chain.rpcUrl });
  tee = await startMockTee({ pki, registry, storage, bucket: 'mock-bucket' });
  exam = await publishDirect(chain, 'mock-tee-attestation-check', timings.future);
  await tee.init(exam.examId);
});

afterAll(async () => {
  await tee?.stop();
  pki?.stop();
  await chain?.stop();
});

async function attestationVerdict(trustedRoot?: Uint8Array, storageBucket = 'mock-bucket') {
  const response = (await fetch(`${tee.url}/v1/attestation`).then((r) => r.json())) as {
    token: string;
    instancePublicKey: Hex;
    encryptionPublicKey: Hex;
    instanceKeySignature: Hex;
  };
  const expected: ExpectedClaims = {
    instancePublicKey: fromHex(response.instancePublicKey),
    encryptionPublicKey: fromHex(response.encryptionPublicKey),
    instanceKeySignature: fromHex(response.instanceKeySignature),
    examId: fromHex(exam.examId),
    imageDigest: (await createExamRegistry({ address: chain.registry, rpcUrl: chain.rpcUrl }).getExam(exam.examId))?.imageDigest as Hex,
    approvedHwModels: attestationSpec.hwModels,
    settings: exam.settings,
    registry: chain.registry,
    storageBucket,
  };
  return checkToken(response.token, expected, { mode: 'live', now: Math.floor(Date.now() / 1000), ...(trustedRoot ? { trustedRoot } : {}) });
}

describe('mock sealed machine', () => {
  it('passes every attestation check against a trusted mock root', async () => {
    const verdict = await attestationVerdict(pki.rootDer);
    expect(verdict.claims.filter((claim) => !claim.ok)).toEqual([]);
    expect(verdict.signature.ok ? 'ok' : verdict.signature.error.message).toBe('ok');
    expect(verdict.instanceKey.ok).toBe(true);
    expect(verdict.trusted).toBe(true);
  });

  it('is refused under Google’s root, which is what the apps use outside mock mode', async () => {
    const verdict = await attestationVerdict();
    expect(verdict.signature.ok).toBe(false);
    expect(verdict.trusted).toBe(false);
  });

  it('fails the claim check for a bucket the machine was not started with', async () => {
    const verdict = await attestationVerdict(pki.rootDer, 'another-bucket');
    expect(verdict.trusted).toBe(false);
    expect(verdict.claims.filter((claim) => !claim.ok).map((claim) => claim.claim)).toEqual(['env_override']);
  });
});
