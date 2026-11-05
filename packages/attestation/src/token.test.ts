import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { encodeMessage, attestationNonce, startupArgs, type ExamSettings, type Hex } from '@paperseal/protocol';
import { BasicConstraintsExtension, X509CertificateGenerator, X509Certificate } from '@peculiar/x509';
import { CompactSign } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  checkToken,
  GOOGLE_ROOT_DER_BASE64,
  GOOGLE_ROOT_SHA1,
  TokenSignatureError,
  TokenSignatureNotImplementedError,
  verifyInstanceKey,
  verifyPkiToken,
  verifyTokenSignature,
  type CheckOptions,
  type ExpectedClaims,
} from './index';

const subtle = globalThis.crypto.subtle;
const rsa = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
const b64 = (data: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(data)));
const b64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const iat = 1_800_000_000;
const day = 86_400_000;

interface Pki {
  root: X509Certificate;
  intermediate: X509Certificate;
  leaf: X509Certificate;
  leafKey: CryptoKey;
}

async function makePki(options: { intermediateIsCa?: boolean; notBefore?: Date; notAfter?: Date; name?: string } = {}): Promise<Pki> {
  const { intermediateIsCa = true, notBefore = new Date(iat * 1000 - 30 * day), notAfter = new Date(iat * 1000 + 30 * day), name = 'Test' } = options;
  const [rootKeys, interKeys, leafKeys] = await Promise.all([
    subtle.generateKey(rsa, true, ['sign', 'verify']),
    subtle.generateKey(rsa, true, ['sign', 'verify']),
    subtle.generateKey(rsa, true, ['sign', 'verify']),
  ]);
  const base = { notBefore, notAfter, signingAlgorithm: rsa };
  const root = await X509CertificateGenerator.createSelfSigned({
    ...base,
    serialNumber: '01',
    name: `CN=${name} Root`,
    keys: rootKeys,
    extensions: [new BasicConstraintsExtension(true, undefined, true)],
  });
  const intermediate = await X509CertificateGenerator.create({
    ...base,
    serialNumber: '02',
    subject: `CN=${name} Intermediate`,
    issuer: root.subject,
    publicKey: interKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new BasicConstraintsExtension(intermediateIsCa, undefined, true)],
  });
  const leaf = await X509CertificateGenerator.create({
    ...base,
    serialNumber: '03',
    subject: `CN=${name} Leaf`,
    issuer: intermediate.subject,
    publicKey: leafKeys.publicKey,
    signingKey: interKeys.privateKey,
  });
  return { root, intermediate, leaf, leafKey: leafKeys.privateKey };
}

async function signToken(
  claims: Record<string, unknown>,
  pki: Pki,
  header: Record<string, unknown> = { alg: 'RS256', x5c: [b64(pki.leaf.rawData), b64(pki.intermediate.rawData), b64(pki.root.rawData)] },
): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader(header as { alg: string }).sign(pki.leafKey);
}

const rootOf = (pki: Pki) => new Uint8Array(pki.root.rawData);

describe("Google's pinned root", () => {
  const der = Uint8Array.from(atob(GOOGLE_ROOT_DER_BASE64), (c) => c.charCodeAt(0));

  it('has the SHA-1 fingerprint Google documents, and is the root tee/ embeds', () => {
    expect(createHash('sha1').update(der).digest('hex')).toBe(GOOGLE_ROOT_SHA1);
    expect(GOOGLE_ROOT_SHA1).toBe('b95120742c24e3aa34042e1c3ba3aad28b212321');
    const pem = readFileSync(resolve(import.meta.dirname, '../../../tee/internal/attestation/confidential_space_root.pem'), 'utf8');
    expect(Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64').equals(Buffer.from(der))).toBe(true);
  });

  it('is a self-signed CA', async () => {
    const root = new X509Certificate(der);
    expect(root.subject).toContain('Confidential Space Root CA');
    expect(root.subject).toBe(root.issuer);
    expect(root.getExtension(BasicConstraintsExtension)?.ca).toBe(true);
    expect(await root.verify({ date: new Date('2025-06-01') })).toBe(true);
  });
});

describe('verifyPkiToken', () => {
  const claims = { iss: 'x', iat };

  it('accepts a token signed through a chain to the root, whatever its exp says', async () => {
    const pki = await makePki();
    expect(await verifyPkiToken(await signToken({ ...claims, exp: iat + 5 }, pki), rootOf(pki))).toEqual({ ok: true });
  });

  it("rejects a chain that does not end at Google's pinned root", async () => {
    const pki = await makePki();
    const token = await signToken(claims, pki);
    const result = await verifyTokenSignature(token);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(TokenSignatureError);
    expect(!result.ok && result.error.message).toContain("Google's root");
  });

  it('rejects another root, even one with a valid chain of its own', async () => {
    const [good, other] = await Promise.all([makePki(), makePki({ name: 'Other' })]);
    expect((await verifyPkiToken(await signToken(claims, other), rootOf(good))).ok).toBe(false);
  });

  it('rejects a tampered payload', async () => {
    const pki = await makePki();
    const [h, , s] = (await signToken(claims, pki)).split('.') as [string, string, string];
    const forged = `${h}.${b64url(JSON.stringify({ ...claims, secboot: true }))}.${s}`;
    const result = await verifyPkiToken(forged, rootOf(pki));
    expect(!result.ok && result.error.message).toContain('signature');
  });

  it('rejects a token signed by a key that is not the leaf', async () => {
    const pki = await makePki();
    const other = await makePki();
    const token = await signToken(claims, { ...pki, leafKey: other.leafKey });
    expect((await verifyPkiToken(token, rootOf(pki))).ok).toBe(false);
  });

  it('rejects a chain of the wrong length', async () => {
    const pki = await makePki();
    const token = await signToken(claims, pki, { alg: 'RS256', x5c: [b64(pki.leaf.rawData), b64(pki.root.rawData)] });
    const result = await verifyPkiToken(token, rootOf(pki));
    expect(!result.ok && result.error.message).toContain('want 3');
  });

  it('rejects certificates that were not valid at iat, and accepts the same chain later or earlier only as of iat', async () => {
    const expired = await makePki({ notBefore: new Date((iat - 90 * 86400) * 1000), notAfter: new Date((iat - 60 * 86400) * 1000) });
    expect((await verifyPkiToken(await signToken(claims, expired), rootOf(expired))).ok).toBe(false);
    const future = await makePki({ notBefore: new Date((iat + 60 * 86400) * 1000), notAfter: new Date((iat + 90 * 86400) * 1000) });
    expect((await verifyPkiToken(await signToken(claims, future), rootOf(future))).ok).toBe(false);
  });

  it('rejects an intermediate that is not a CA', async () => {
    const pki = await makePki({ intermediateIsCa: false });
    const result = await verifyPkiToken(await signToken(claims, pki), rootOf(pki));
    expect(!result.ok && result.error.message).toContain('not a CA');
  });

  it('rejects a leaf that the intermediate did not issue', async () => {
    const a = await makePki();
    const b = await makePki({ name: 'B' });
    const token = await signToken(claims, a, { alg: 'RS256', x5c: [b64(a.leaf.rawData), b64(b.intermediate.rawData), b64(a.root.rawData)] });
    expect((await verifyPkiToken(token, rootOf(a))).ok).toBe(false);
  });

  it('rejects a token with no iat, a non-RS256 alg and garbage', async () => {
    const pki = await makePki();
    expect((await verifyPkiToken(await signToken({ iss: 'x' }, pki), rootOf(pki))).ok).toBe(false);
    const header = { alg: 'RS512', x5c: [b64(pki.leaf.rawData), b64(pki.intermediate.rawData), b64(pki.root.rawData)] };
    const [, payload, signature] = (await signToken(claims, pki)).split('.') as [string, string, string];
    const swapped = `${b64url(JSON.stringify(header))}.${payload}.${signature}`;
    const result = await verifyPkiToken(swapped, rootOf(pki));
    expect(!result.ok && result.error.message).toContain('want RS256');
    expect((await verifyPkiToken('a.b.c', rootOf(pki))).ok).toBe(false);
  });

  it('reports an OIDC token, which has a kid and no chain, as not implemented', async () => {
    const pki = await makePki();
    const token = await signToken(claims, pki, { alg: 'RS256', kid: 'abc' });
    const result = await verifyTokenSignature(token);
    expect(!result.ok && result.error).toBeInstanceOf(TokenSignatureNotImplementedError);
  });
});

describe('checkToken with instanceKeySignature', () => {
  const examId = new Uint8Array(32).fill(9);
  const registry: Hex = '0x00000000000000000000000000000000000000aa';
  const settings: ExamSettings = {
    examId: `0x${'09'.repeat(32)}`,
    examStart: 1_900_000_000,
    delta: 3600,
    lockRound: '100',
    unlockRound: '200',
    endRound: '300',
    criteriaHash: `0x${'33'.repeat(32)}`,
    rpcHost: 'rpc.example.org',
    registry,
    chainId: 11155111,
  };
  const ecdsa = { name: 'ECDSA', namedCurve: 'P-256' };
  const live = (pki: Pki): CheckOptions => ({ mode: 'published', now: iat + 100, trustedRoot: rootOf(pki) });

  const keyPair = async () => {
    const pair = await subtle.generateKey(ecdsa, true, ['sign', 'verify']);
    return { pair, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
  };
  /** Low-s r || s over the message preimage, as the TEE signs. */
  async function sign(key: CryptoKey, preimage: Uint8Array): Promise<Uint8Array> {
    const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(preimage)));
    const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    let s = 0n;
    for (const byte of raw.subarray(32)) s = (s << 8n) | BigInt(byte);
    if (s > order / 2n) raw.set(Uint8Array.from(Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex')), 32);
    return raw;
  }

  async function setup() {
    const [pki, signing, encryption] = await Promise.all([makePki(), keyPair(), keyPair()]);
    const instanceKeySignature = await sign(
      signing.pair.privateKey,
      encodeMessage('instanceKey', { examId, encryptionPublicKey: encryption.publicKey }),
    );
    const expected: ExpectedClaims = {
      instancePublicKey: signing.publicKey,
      encryptionPublicKey: encryption.publicKey,
      instanceKeySignature,
      examId,
      imageDigest: `0x${'ab'.repeat(32)}`,
      approvedHwModels: ['GCP_AMD_SEV'],
      settings,
      registry,
      cmdOverride: [],
      env: {},
    };
    const claims = {
      iss: 'https://confidentialcomputing.googleapis.com',
      aud: 'paperseal',
      iat,
      exp: iat + 3600,
      swname: 'CONFIDENTIAL_SPACE',
      dbgstat: 'disabled-since-boot',
      hwmodel: 'GCP_AMD_SEV',
      secboot: true,
      eat_nonce: attestationNonce(signing.publicKey, examId),
      submods: {
        confidential_space: { support_attributes: ['STABLE'] },
        container: { image_digest: `sha256:${'ab'.repeat(32)}`, args: startupArgs(settings), cmd_override: [], env: {} },
      },
    };
    return { pki, signing, encryption, expected, claims, token: await signToken(claims, pki) };
  }

  it('trusts a token whose signature, claims and instanceKeySignature all pass', async () => {
    const { pki, expected, token } = await setup();
    const verdict = await checkToken(token, expected, live(pki));
    expect(verdict.signature).toEqual({ ok: true });
    expect(verdict.instanceKey).toEqual({ ok: true });
    expect(verdict.claims.filter((c) => !c.ok)).toEqual([]);
    expect(verdict.trusted).toBe(true);
  });

  it('does not trust a token under the default Google root', async () => {
    const { pki, expected, token } = await setup();
    const { trustedRoot: _root, ...options } = live(pki);
    expect((await checkToken(token, expected, options)).trusted).toBe(false);
  });

  it('does not trust an encryption key the signing key did not sign', async () => {
    const { pki, expected, token } = await setup();
    const other = await keyPair();
    const verdict = await checkToken(token, { ...expected, encryptionPublicKey: other.publicKey }, live(pki));
    expect(verdict.instanceKey.ok).toBe(false);
    expect(verdict.claims.filter((c) => !c.ok)).toEqual([]);
    expect(verdict.trusted).toBe(false);
  });

  it('does not trust an instanceKeySignature from another key, another exam or the wrong shape', async () => {
    const { pki, expected, token, encryption } = await setup();
    const stranger = await keyPair();
    const forged = await sign(stranger.pair.privateKey, encodeMessage('instanceKey', { examId, encryptionPublicKey: encryption.publicKey }));
    expect((await checkToken(token, { ...expected, instanceKeySignature: forged }, live(pki))).trusted).toBe(false);
    expect((await verifyInstanceKey({ ...expected, examId: new Uint8Array(32) })).ok).toBe(false);
    expect((await verifyInstanceKey({ ...expected, instanceKeySignature: new Uint8Array(10) })).ok).toBe(false);
    expect((await verifyInstanceKey({ ...expected, encryptionPublicKey: new Uint8Array(3) })).ok).toBe(false);
  });

  it('does not trust a token whose eat_nonce binds a different instancePublicKey', async () => {
    const { pki, expected, claims } = await setup();
    const other = await keyPair();
    const token = await signToken({ ...claims, eat_nonce: attestationNonce(other.publicKey, examId) }, pki);
    const verdict = await checkToken(token, expected, live(pki));
    expect(verdict.claims.find((c) => c.claim === 'eat_nonce')?.ok).toBe(false);
    expect(verdict.signature.ok).toBe(true);
    expect(verdict.instanceKey.ok).toBe(true);
    expect(verdict.trusted).toBe(false);
  });
});
