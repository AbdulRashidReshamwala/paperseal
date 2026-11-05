import { hpkeContext, hpkeOpen } from '@paperseal/crypto';
import { encodeQuestion, fromHex, padding, parseQuestion, questionHash, toHex, unpad, utf8ToBytes } from '@paperseal/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmTee, type Confirmed } from './confirm';
import { compareWithBuild, loadReceipts, verifyReceipt, type StoredReceipt } from './receipts';
import { checkQuestion, ReceiptInvalidError, sealAndSubmit, SubmitBlockedError } from './submit';
import { credentialId, examId, makeSigner, makeWorld, passkeyPublicKey, postedBody, submissionDigest, type World } from './testkit';

const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  });
});

const secret = 'The speed of the cobalt marmot is 4711 m/s';
const question = { topic: 'Mechanics', text: secret };

async function confirmWorld(world: World) {
  const { env } = world;
  return confirmTee({
    examId,
    registryAddress: env.registryAddress as `0x${string}`,
    tee: world.tee,
    chain: world.chain,
    policy: env.policy,
    ...(env.verifyToken ? { verifyToken: env.verifyToken } : {}),
  });
}

async function confirmed(world: World): Promise<Confirmed> {
  const outcome = await confirmWorld(world);
  if (!outcome.ok) throw new Error(outcome.reasons.join('; '));
  return outcome.confirmed;
}

const submitDeps = (world: World) => ({
  keys: world.env.keys(),
  tee: world.tee,
  credentialId,
  passkeyPublicKey,
});

describe('confirm', () => {
  it('passes when attestation is trusted and the list hash matches the chain', async () => {
    const outcome = await confirmWorld(await makeWorld());
    expect(outcome.ok).toBe(true);
  });

  it('is blocked, with every reason, when attestation fails', async () => {
    const world = await makeWorld({ realAttestation: true });
    const outcome = await confirmWorld(world);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.step).toBe('attestation');
    expect(outcome.verdict?.trusted).toBe(false);
    const text = outcome.reasons.join('\n');
    expect(text).toContain('Token signature');
    expect(text).toContain('Claim iss');
    expect(text).toContain('Claim eat_nonce');
    expect(text).toContain('Claim hwmodel');
  });

  it('is blocked when the token cannot be fetched', async () => {
    const world = await makeWorld();
    world.tee.attestation = () => Promise.reject(new TypeError('fetch failed'));
    const outcome = await confirmWorld(world);
    expect(outcome).toMatchObject({ ok: false, step: 'attestation' });
  });

  it('is blocked on a list hash mismatch with the chain, even though attestation passed', async () => {
    const world = await makeWorld({ chainListHashOverride: `0x${'cd'.repeat(32)}` });
    const outcome = await confirmWorld(world);
    expect(world.verifyToken).toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, step: 'list' });
    if (!outcome.ok) expect(outcome.reasons.join(' ')).toContain('List hash mismatch');
  });

  it('is blocked when the list is not posted on-chain', async () => {
    const world = await makeWorld();
    world.chain.getApprovedList = () => Promise.resolve(null);
    expect(await confirmWorld(world)).toMatchObject({ ok: false, step: 'list' });
  });

  it('is blocked when the TEE list signature is not from its instance key', async () => {
    const world = await makeWorld();
    const status = world.tee.status;
    world.tee.status = async () => {
      const real = await status();
      const other = await makeSigner();
      return {
        ...real,
        approvedList: { ...(real.approvedList as NonNullable<typeof real.approvedList>), teeSignature: await other.sign(utf8ToBytes('x')) },
      };
    };
    const outcome = await confirmWorld(world);
    expect(outcome).toMatchObject({ ok: false, step: 'list' });
  });
});

describe('sealing', () => {
  it('sends an opaque payload that only the TEE key opens', async () => {
    const world = await makeWorld();
    await sealAndSubmit(submitDeps(world), await confirmed(world), question);
    const body = postedBody(world);
    const ciphertext = fromHex(body.ciphertext);

    expect(JSON.stringify(body)).not.toContain('marmot');
    const asText = new TextDecoder('latin1').decode(ciphertext);
    expect(asText).not.toContain('marmot');
    // enc (65) + padded question + 16-byte tag, whatever the text.
    expect(ciphertext.length).toBe(65 + padding.questionBytes + 16);

    const padded = await hpkeOpen(world.encryption, ciphertext, hpkeContext('question', fromHex(examId)));
    expect(parseQuestion(unpad(padded, padding.questionBytes))).toEqual(question);
  });

  it('gives questions of different lengths ciphertexts of the same length', async () => {
    const world = await makeWorld();
    const proof = await confirmed(world);
    await sealAndSubmit(submitDeps(world), proof, { topic: 'Optics', text: 'a' });
    await sealAndSubmit(submitDeps(world), proof, { topic: 'Optics', text: 'b'.repeat(2000) });
    const lengths = [0, 1].map((n) => fromHex(postedBody(world, n).ciphertext).length);
    expect(new Set(lengths).size).toBe(1);
  });

  it('signs the questionSubmission digest over the ciphertext hash and the TEE challenge', async () => {
    const world = await makeWorld();
    const receipt = await sealAndSubmit(submitDeps(world), await confirmed(world), question);
    const body = postedBody(world);
    const expected = submissionDigest(body.challenge, questionHash(fromHex(body.ciphertext)));
    expect(world.signed).toHaveLength(1);
    expect(toHex(world.signed[0] ?? new Uint8Array())).toBe(toHex(expected));
    expect(receipt.questionHash).toBe(toHex(questionHash(fromHex(body.ciphertext))));
  });

  it('is a hash of the ciphertext, never of the plaintext', async () => {
    const world = await makeWorld();
    const receipt = await sealAndSubmit(submitDeps(world), await confirmed(world), question);
    const plain = toHex(questionHash(encodeQuestion(question)));
    expect(receipt.questionHash).not.toBe(plain);
  });

  it('keeps a verified receipt per exam with the question hash and instance key', async () => {
    const world = await makeWorld();
    const receipt = await sealAndSubmit(submitDeps(world), await confirmed(world), question);
    expect(receipt.instancePublicKey).toBe(world.signer.publicKey);
    expect(loadReceipts(examId)).toEqual([receipt]);
    expect(await verifyReceipt(examId, passkeyPublicKey, receipt)).toBe(true);
  });

  it('rejects a receipt signed by a key other than the attested instance key', async () => {
    const world = await makeWorld({ receiptSigner: await makeSigner() });
    await expect(sealAndSubmit(submitDeps(world), await confirmed(world), question)).rejects.toBeInstanceOf(
      ReceiptInvalidError,
    );
    expect(loadReceipts(examId)).toEqual([]);
  });

  it('rejects a receipt for another question hash', async () => {
    const world = await makeWorld({ wrongReceiptHash: true });
    await expect(sealAndSubmit(submitDeps(world), await confirmed(world), question)).rejects.toBeInstanceOf(
      ReceiptInvalidError,
    );
    expect(loadReceipts(examId)).toEqual([]);
  });

  it('only submits at the submit stage', async () => {
    const world = await makeWorld();
    const proof = await confirmed(world);
    world.stage.current = 'lock';
    await expect(sealAndSubmit(submitDeps(world), proof, question)).rejects.toBeInstanceOf(SubmitBlockedError);
    expect(world.teeQuestion).not.toHaveBeenCalled();
    expect(world.signed).toEqual([]);
  });

  it('rejects an invalid question before encrypting', async () => {
    const world = await makeWorld();
    const proof = await confirmed(world);
    await expect(sealAndSubmit(submitDeps(world), proof, { topic: 'Biology', text: 'x' })).rejects.toBeInstanceOf(
      SubmitBlockedError,
    );
    expect(world.teeQuestion).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  const topics = { maxSetterPercent: 50, minBankMultiple: 2, topics: [{ name: 'Mechanics', questions: 2 }] };

  it('checks topic, text and size against the padding', () => {
    expect(checkQuestion(topics, { topic: 'Mechanics', text: 'ok' }).error).toBeNull();
    expect(checkQuestion(topics, { topic: 'Nope', text: 'ok' }).error).toContain('topic');
    expect(checkQuestion(topics, { topic: 'Mechanics', text: '  ' }).error).toContain('Enter');
    const big = checkQuestion(topics, { topic: 'Mechanics', text: 'x'.repeat(padding.questionBytes) });
    expect(big.error).toContain('fit');
    expect(big.limit).toBe(padding.questionBytes - 4);
  });
});

describe('receipt against the Build', () => {
  const receipt = (key: string): StoredReceipt => ({
    questionHash: `0x${'11'.repeat(32)}`,
    instancePublicKey: key as `0x${string}`,
    teeSignature: '0x00',
    sealedAt: 0,
  });
  const keyA = `0x04${'aa'.repeat(64)}`;
  const keyB = `0x04${'bb'.repeat(64)}`;

  it('matches, mismatches and waits', () => {
    expect(compareWithBuild([receipt(keyA)], keyA as `0x${string}`)[0]?.match).toBe('match');
    expect(compareWithBuild([receipt(keyA)], keyB as `0x${string}`)[0]?.match).toBe('mismatch');
    expect(compareWithBuild([receipt(keyA)], null)[0]?.match).toBe('pending');
  });
});
