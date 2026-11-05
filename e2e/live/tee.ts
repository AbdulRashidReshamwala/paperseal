import {
  checkClaims,
  checkToken,
  decodeToken,
  verifyPkiToken,
  type ExpectedClaims,
  type TokenVerdict,
} from '@paperseal/attestation';
import { verifyTeeSignature } from '@paperseal/crypto';
import {
  approvedListHash,
  attestation,
  chain,
  criteriaHash,
  decodeCriteria,
  encodeMessage,
  equalBytes,
  fromHex,
  toHex,
  type Criteria,
  type ExamSettings,
  type Hex,
} from '@paperseal/protocol';
import { createTeeClient, type AttestationResponse, type StatusResponse, type TeeClient } from '@paperseal/tee-client';

import type { ChainIo } from './chainio';
import { deployed } from './config';
import { retryTransient } from './util';

/*
 * The TEE as the apps see it: nothing is sent to its keys until `checkToken` says `trusted`, and
 * the settings the token must show come from the chain, never from the TEE or from this run's
 * own state. This mirrors apps/web shared/attest.ts and areas/setter/confirm.ts.
 */

export interface Env {
  io: ChainIo;
  examId: Hex;
  tee: TeeClient;
}

export function connectTee(): TeeClient {
  return createTeeClient({ baseUrl: deployed.teeUrl });
}

/** Reads on a TEE GET are retried on transient errors (including a Cloudflare 52x while the VM boots). */
export const teeRead = <T>(run: () => Promise<T>): Promise<T> => retryTransient(run);

export async function chainSettings(env: Pick<Env, 'io' | 'examId'>): Promise<{ settings: ExamSettings; imageDigest: Hex; criteria: Criteria }> {
  const { io, examId } = env;
  const exam = await io.read(() => io.registry.getExam(examId));
  if (!exam) throw new Error('this exam is not published on ExamRegistry');
  const encoded = await io.read(() => io.registry.getCriteria(examId));
  if (!encoded) throw new Error('the exam criteria could not be read from the chain');
  const bytes = fromHex(encoded);
  if (!equalBytes(criteriaHash(bytes), fromHex(exam.settings.criteriaHash))) {
    throw new Error('the criteria on-chain do not match the criteria hash in the exam settings');
  }
  const s = exam.settings;
  return {
    imageDigest: exam.imageDigest,
    criteria: decodeCriteria(bytes),
    settings: {
      examId: s.examId,
      examStart: Number(s.examStart),
      delta: Number(s.delta),
      lockRound: s.lockRound.toString(),
      unlockRound: s.unlockRound.toString(),
      endRound: s.endRound.toString(),
      criteriaHash: s.criteriaHash,
      rpcHost: s.rpcHost,
      registry: deployed.registry,
      chainId: chain.chainId,
    },
  };
}

const show = (value: unknown): string => JSON.stringify(value) ?? 'missing';

/** One line per failing check, with what was expected and the actual value. */
export function failingClaims(verdict: TokenVerdict): string[] {
  const lines: string[] = [];
  if (!verdict.signature.ok) lines.push(`token signature: ${verdict.signature.error.message}`);
  if (!verdict.instanceKey.ok) lines.push(`instance key signature: ${verdict.instanceKey.error ?? 'does not verify'}`);
  for (const claim of verdict.claims) {
    if (!claim.ok) lines.push(`claim ${claim.claim}: expected ${claim.expected}; actual ${show(claim.actual)}${claim.note ? ` (${claim.note})` : ''}`);
  }
  return lines;
}

export class UntrustedTeeError extends Error {
  readonly lines: string[];
  constructor(lines: string[]) {
    super(`the TEE attestation is not trusted:\n  ${lines.join('\n  ')}`);
    this.name = 'UntrustedTeeError';
    this.lines = lines;
  }
}

function expectedFor(env: Env, chainBound: Awaited<ReturnType<typeof chainSettings>>, a: AttestationResponse): ExpectedClaims {
  return {
    instancePublicKey: fromHex(a.instancePublicKey),
    encryptionPublicKey: fromHex(a.encryptionPublicKey),
    instanceKeySignature: fromHex(a.instanceKeySignature),
    examId: fromHex(env.examId),
    imageDigest: chainBound.imageDigest,
    approvedHwModels: attestation.hwModels,
    settings: chainBound.settings,
    registry: deployed.registry,
    storageBucket: deployed.storageBucket,
  };
}

export interface Attested {
  attestation: AttestationResponse;
  verdict: TokenVerdict;
  claimLines: string[];
}

/** A fresh live attestation checked with `trusted`. Returns the verdict either way. */
export async function attest(env: Env): Promise<Attested> {
  const bound = await chainSettings(env);
  const attestation = await teeRead(() => env.tee.attestation());
  const verdict = await checkToken(attestation.token, expectedFor(env, bound, attestation), {
    mode: 'live',
    now: Math.floor(Date.now() / 1000),
  });
  return { attestation, verdict, claimLines: failingClaims(verdict) };
}

/** Throws `UntrustedTeeError` listing every failing claim unless the attestation is trusted. */
export async function requireTrusted(env: Env): Promise<Attested> {
  const result = await attest(env);
  if (!result.verdict.trusted) {
    throw new UntrustedTeeError(result.claimLines.length > 0 ? result.claimLines : ['the verdict was not trusted but no claim failed']);
  }
  return result;
}

export interface Confirmed {
  encryptionPublicKey: Uint8Array;
  instancePublicKey: Hex;
  criteria: Criteria;
  status: StatusResponse;
}

/**
 * Setter Confirm: a trusted attestation, then the list hash the TEE signed must equal the chain's.
 * Throws with every reason; nothing is encrypted before this passes.
 */
export async function confirm(env: Env): Promise<Confirmed> {
  const { attestation, verdict, claimLines } = await attest(env);
  if (!verdict.trusted) throw new UntrustedTeeError(claimLines);
  const { criteria } = await chainSettings(env);
  const status = await teeRead(() => env.tee.status());
  const list = status.approvedList;
  if (!list) throw new Error('the TEE has not published a signed approved list yet');
  if (list.examId.toLowerCase() !== env.examId.toLowerCase()) throw new Error('the TEE list is for a different exam');
  const hash = approvedListHash(fromHex(list.examId), fromHex(list.entries));
  if (!equalBytes(hash, fromHex(list.hash))) throw new Error('the list hash the TEE reports does not match the list it sent');
  const signed = await verifyTeeSignature(
    fromHex(attestation.instancePublicKey),
    fromHex(list.teeSignature),
    encodeMessage('approvedList', { examId: fromHex(list.examId), entries: fromHex(list.entries) }),
  );
  if (!signed) throw new Error('the TEE signature on the approved list is invalid');
  const onChain = await env.io.read(() => env.io.registry.getApprovedList(env.examId));
  if (!onChain) throw new Error('the approved list is not on-chain yet');
  if (!equalBytes(fromHex(onChain.listHash), hash)) {
    throw new Error(`list hash mismatch: the TEE signed ${toHex(hash)} but the chain has ${onChain.listHash}`);
  }
  return {
    encryptionPublicKey: fromHex(attestation.encryptionPublicKey),
    instancePublicKey: attestation.instancePublicKey,
    criteria,
    status,
  };
}

/** A published PKI token (token.jwt, release-token.jwt) checked as a record: signature and claims, no expiry. */
export async function checkPublishedToken(env: Pick<Env, 'io' | 'examId'>, token: string, instancePublicKey: Hex): Promise<string[]> {
  const bound = await chainSettings(env);
  const expected: ExpectedClaims = {
    instancePublicKey: fromHex(instancePublicKey),
    // checkClaims does not use these two; the instance key signature is checked on live tokens.
    encryptionPublicKey: new Uint8Array(),
    instanceKeySignature: new Uint8Array(),
    examId: fromHex(env.examId),
    imageDigest: bound.imageDigest,
    approvedHwModels: attestation.hwModels,
    settings: bound.settings,
    registry: deployed.registry,
    storageBucket: deployed.storageBucket,
  };
  const failures: string[] = [];
  const signature = await verifyPkiToken(token);
  if (!signature.ok) failures.push(`token signature: ${signature.error.message}`);
  for (const claim of checkClaims(decodeToken(token), expected, { mode: 'published', now: Math.floor(Date.now() / 1000) })) {
    if (!claim.ok) failures.push(`claim ${claim.claim}: expected ${claim.expected}; actual ${show(claim.actual)}`);
  }
  return failures;
}
