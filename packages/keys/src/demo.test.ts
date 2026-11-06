import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { hpkeContext, hpkeSeal } from '@paperseal/crypto';
import { p256 } from '@noble/curves/nist';
import { fromHex, hashMessage, inviteTag, passkeyRecordValue, setterOwner, toHex, type Hex } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import { demoSeed, plantedKey, plantedRecords, softwareCredentials } from './demo';
import { createWebAuthnKeys, KeyError } from './index';

/*
 * The planted keys run through the real `createWebAuthnKeys`, so everything below is what the app sends.
 * `spec/fixtures/demo-keys.json` is the same output, kept for `tee/internal/webauthn`, whose test gives it
 * to the real `webauthn.Verify`. Signing is deterministic, so a change here shows up as a stale fixture.
 * To write it again: UPDATE_DEMO_FIXTURE=1 pnpm --filter @paperseal/keys test
 */

const fixturePath = resolve(import.meta.dirname, '../../../spec/fixtures/demo-keys.json');
const origin = 'http://localhost:5171';
const rpId = 'localhost';
const examId = fromHex(`0x${'ee'.repeat(32)}`);
const challenge = new Uint8Array(32).fill(0xc1);
const inviteSecret = new Uint8Array(32).fill(0x5e);

async function keysOf(label: string) {
  const planted = await plantedKey(label);
  return { planted, keys: createWebAuthnKeys({ rpId, rpName: 'Paper Seal', credentials: softwareCredentials(planted, origin) }) };
}

const signatureHex = (signature: { signature: Uint8Array; authenticatorData: Uint8Array; clientDataJSON: Uint8Array }) => ({
  signature: toHex(signature.signature),
  authenticatorData: toHex(signature.authenticatorData),
  clientDataJSON: toHex(signature.clientDataJSON),
});

async function fixture() {
  const setter = await keysOf('setter-1');
  const centre = await keysOf('centre-1');
  const registered = await setter.keys.register({ role: 'setter', challenge, inviteSecret });
  const { passkey, credentialId } = plantedRecords(centre.planted);
  const named = await centre.keys.registerByName({
    owner: 'centre-1.paperseal-demo.eth',
    examId,
    credentialId: fromHex(credentialId),
    passkey,
    challenge: () => Promise.resolve(challenge),
  });
  const questionHash = new Uint8Array(32).fill(0x9a);
  const question = hashMessage('questionSubmission', { examId, challenge, questionHash });
  const release = hashMessage('shareRelease', { examId, challenge });
  return {
    origin,
    rpId,
    examId: toHex(examId),
    setter: registered.request,
    byName: named.request,
    question: {
      passkeyPublicKey: registered.request.passkeyPublicKey,
      challenge: toHex(challenge),
      questionHash: toHex(questionHash),
      ...signatureHex(await setter.keys.sign(registered.credentialId, question)),
    },
    release: {
      passkeyPublicKey: named.request.passkeyPublicKey,
      challenge: toHex(challenge),
      ...signatureHex(await centre.keys.sign(fromHex(credentialId), release)),
    },
  };
}

describe('planted keys', () => {
  it('are fixed for a label, different per person, and real P-256 keys', async () => {
    const first = await plantedKey('neutral-1');
    const again = await plantedKey('neutral-1');
    const other = await plantedKey('neutral-2');
    expect(toHex(again.publicKey)).toBe(toHex(first.publicKey));
    expect(toHex(again.credentialId)).toBe(toHex(first.credentialId));
    expect(toHex(again.prfSecret)).toBe(toHex(first.prfSecret));
    expect(toHex(other.publicKey)).not.toBe(toHex(first.publicKey));
    expect(toHex(other.credentialId)).not.toBe(toHex(first.credentialId));
    expect(toHex(other.prfSecret)).not.toBe(toHex(first.prfSecret));
    expect(first.publicKey).toHaveLength(65);
    expect(() => p256.ProjectivePoint.fromHex(first.publicKey).assertValidity()).not.toThrow();
    expect(demoSeed).toContain('public seed');
  });

  it('give the record values a name publishes', async () => {
    const key = await plantedKey('centre-3');
    expect(plantedRecords(key)).toEqual({ passkey: passkeyRecordValue(key.publicKey), credentialId: toHex(key.credentialId) });
  });
});

describe('software credentials', () => {
  it('make a create response the key code accepts, holding the planted key', async () => {
    const { planted, keys } = await keysOf('neutral-1');
    const made = await keys.generateKey({ id: new Uint8Array(32), name: 'Paper Seal key' });
    expect(toHex(made.passkeyPublicKey)).toBe(toHex(planted.publicKey));
    expect(toHex(made.credentialId)).toBe(toHex(planted.credentialId));
    const client = JSON.parse(new TextDecoder().decode(made.clientDataJSON)) as Record<string, unknown>;
    expect(client).toMatchObject({ type: 'webauthn.create', origin, crossOrigin: false });
  });

  it('sign with the planted key, with UP and UV set and the backup flags clear', async () => {
    const { planted, keys } = await keysOf('setter-2');
    const message = new Uint8Array(32).fill(3);
    const signature = await keys.sign(planted.credentialId, message);
    expect(signature.authenticatorData).toHaveLength(37);
    expect(signature.authenticatorData[32]).toBe(0x05);
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
    expect(signature.authenticatorData.subarray(0, 32)).toEqual(rpIdHash);
    const client = JSON.parse(new TextDecoder().decode(signature.clientDataJSON)) as { type: string; challenge: string };
    expect(client.type).toBe('webauthn.get');
    expect(Buffer.from(client.challenge, 'base64url')).toEqual(Buffer.from(message));
    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(signature.clientDataJSON)));
    const signed = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...signature.authenticatorData, ...clientHash])));
    expect(p256.verify(p256.Signature.fromDER(signature.signature).toCompactRawBytes(), signed, planted.publicKey, { prehash: false, lowS: false })).toBe(true);
  });

  it('keep the PRF per credential and per exam, so a sealed share opens with the derived key', async () => {
    const { planted, keys } = await keysOf('neutral-2');
    const other = await keysOf('neutral-3');
    const derived = await keys.getPublicKey(planted.credentialId, examId);
    expect(toHex(await keys.getPublicKey(planted.credentialId, examId))).toBe(toHex(derived));
    expect(toHex(await keys.getPublicKey(planted.credentialId, new Uint8Array(32).fill(1)))).not.toBe(toHex(derived));
    expect(toHex(await other.keys.getPublicKey(other.planted.credentialId, examId))).not.toBe(toHex(derived));

    const share = new Uint8Array(32).fill(7);
    const sealed = await hpkeSeal(derived, share, hpkeContext('share', examId));
    expect(await keys.decryptShare(planted.credentialId, examId, sealed)).toEqual(share);
    const released = await keys.releaseShare(planted.credentialId, examId, new Uint8Array(32).fill(4), sealed);
    expect(released.share).toEqual(share);
    expect(released.signature.authenticatorData[32]).toBe(0x05);
  });

  it('answer like a real key when asked for a credential they do not hold', async () => {
    const { keys } = await keysOf('centre-1');
    const someoneElse = await plantedKey('centre-2');
    await expect(keys.sign(someoneElse.credentialId, new Uint8Array(32))).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('refuse to make a credential they already hold', async () => {
    const { planted, keys } = await keysOf('centre-1');
    const made = keys.generateKey({ id: new Uint8Array(32), name: 'x' }, { excludeCredentials: [planted.credentialId] });
    await expect(made).rejects.toSatisfy((error) => error instanceof KeyError && error.code === 'already_enrolled');
  });

  it('refuse a domain that is not the page', async () => {
    const planted = await plantedKey('centre-1');
    const keys = createWebAuthnKeys({ rpId: 'paperseal.example', rpName: 'Paper Seal', credentials: softwareCredentials(planted, origin) });
    await expect(keys.sign(planted.credentialId, new Uint8Array(32))).rejects.toMatchObject({ name: 'SecurityError' });
  });

  it('refuse a passkey record that is not this key', async () => {
    const { planted, keys } = await keysOf('centre-1');
    const run = keys.registerByName({
      owner: 'centre-1.paperseal-demo.eth',
      examId,
      credentialId: planted.credentialId,
      passkey: passkeyRecordValue((await plantedKey('centre-2')).publicKey),
      challenge: () => Promise.resolve(challenge),
    });
    await expect(run).rejects.toSatisfy((error) => error instanceof KeyError && error.code === 'wrong_key');
  });
});

describe('registration through the real key code', () => {
  it('gives a setter its owner and invite tag from the planted key', async () => {
    const { planted, keys } = await keysOf('setter-1');
    const registered = await keys.register({ role: 'setter', challenge, inviteSecret });
    expect(registered.owner).toBe(setterOwner(planted.publicKey));
    expect(registered.request.inviteTag).toBe(toHex(inviteTag(inviteSecret, planted.publicKey)));
    expect(registered.request.passkeyPublicKey).toBe(toHex(planted.publicKey));
  });

  it('matches the fixture the Go verifier reads', async () => {
    const made = await fixture();
    if (process.env.UPDATE_DEMO_FIXTURE) writeFileSync(fixturePath, `${JSON.stringify(made, null, 2)}\n`);
    const saved = JSON.parse(readFileSync(fixturePath, 'utf8')) as { setter: { signature: Hex } };
    expect(saved).toEqual(made);
  });
});
