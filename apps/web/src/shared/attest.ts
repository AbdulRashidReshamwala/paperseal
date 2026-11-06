import { checkClaims, checkToken, decodeToken, verifyPkiToken, type ExpectedClaims, type TokenVerdict } from '@paperseal/attestation';
import type { ExamRegistry } from '@paperseal/chain';
import { attestation as attestationSpec, chain, fromHex, type ExamSettings, type Hex } from '@paperseal/protocol';
import type { AttestationResponse, TeeClient } from '@paperseal/tee-client';

import { teeStorageBucket } from './config';
import { mockTrustedRoot, rootOption } from './mockMode';

/*
 * The README's claim table, checked by `checkToken` against the exam on-chain. Nothing is sent to
 * the TEE's keys until `trusted` is true, which covers the token signature, every claim and the
 * instance key signature.
 */

export interface AttestationEnvironment {
  registry: Pick<ExamRegistry, 'getExam' | 'address'>;
  examId: Hex;
  /** Overrides `VITE_TEE_STORAGE_BUCKET`. */
  storageBucket?: string;
  /** Unix seconds. */
  now?: () => number;
}

export class AttestationFailedError extends Error {
  readonly verdict: TokenVerdict;

  constructor(verdict: TokenVerdict) {
    super(describeVerdict(verdict));
    this.name = 'AttestationFailedError';
    this.verdict = verdict;
  }
}

/** The failing parts of a verdict, in words. */
export function describeVerdict(verdict: TokenVerdict): string {
  const failures: string[] = [];
  if (!verdict.signature.ok) failures.push(`token signature: ${verdict.signature.error.message}`);
  if (!verdict.instanceKey.ok) failures.push(`instance key: ${verdict.instanceKey.error ?? 'not signed by the instance key'}`);
  for (const claim of verdict.claims) {
    if (!claim.ok) failures.push(`${claim.claim}${claim.note ? ` (${claim.note})` : ''}`);
  }
  return failures.length === 0
    ? 'The TEE attestation was not trusted.'
    : `The TEE attestation failed: ${failures.join('; ')}.`;
}

/** The settings the TEE was started with, from the on-chain exam, for the `args` claim. */
export async function examSettings(
  registry: Pick<ExamRegistry, 'getExam' | 'address'>,
  examId: Hex,
): Promise<{ settings: ExamSettings; imageDigest: Hex }> {
  const exam = await registry.getExam(examId);
  if (!exam) throw new Error('This exam is not published on ExamRegistry.');
  const { settings } = exam;
  return {
    imageDigest: exam.imageDigest,
    settings: {
      examId: settings.examId,
      examStart: Number(settings.examStart),
      delta: Number(settings.delta),
      lockRound: settings.lockRound.toString(),
      unlockRound: settings.unlockRound.toString(),
      endRound: settings.endRound.toString(),
      criteriaHash: settings.criteriaHash,
      rpcHost: settings.rpcHost,
      registry: registry.address,
      chainId: chain.chainId,
    },
  };
}

/** A function that runs `checkToken` on a fresh attestation, against what the chain says. */
export function attestationChecker(environment: AttestationEnvironment) {
  return async (attestation: AttestationResponse): Promise<TokenVerdict> => {
    const { settings, imageDigest } = await examSettings(environment.registry, environment.examId);
    const expected: ExpectedClaims = {
      instancePublicKey: fromHex(attestation.instancePublicKey),
      encryptionPublicKey: fromHex(attestation.encryptionPublicKey),
      instanceKeySignature: fromHex(attestation.instanceKeySignature),
      examId: fromHex(environment.examId),
      imageDigest,
      approvedHwModels: attestationSpec.hwModels,
      settings,
      registry: environment.registry.address,
      storageBucket: environment.storageBucket ?? teeStorageBucket,
    };
    return checkToken(attestation.token, expected, {
      mode: 'live',
      now: environment.now?.() ?? Math.floor(Date.now() / 1000),
      ...rootOption(),
    });
  };
}

export interface PublishedTokenResult {
  passed: boolean;
  /** Why it failed, in words. Empty when it passed. */
  failures: string[];
}

/**
 * Checks a published PKI token, such as `release-token.jwt`, which attests `instancePublicKey`. It
 * is a record, so the signature is checked against Google's root and the expiry is skipped. The
 * token says nothing about the instance's encryption key, so only the signature and the claims are
 * checked, which include `eat_nonce` binding `instancePublicKey` and the exam.
 */
export function publishedTokenChecker(environment: AttestationEnvironment) {
  return async (token: string, instancePublicKey: Hex): Promise<PublishedTokenResult> => {
    try {
      const { settings, imageDigest } = await examSettings(environment.registry, environment.examId);
      const expected: ExpectedClaims = {
        instancePublicKey: fromHex(instancePublicKey),
        // `checkClaims` does not use these two. The instance key signature is checked on live tokens.
        encryptionPublicKey: new Uint8Array(),
        instanceKeySignature: new Uint8Array(),
        examId: fromHex(environment.examId),
        imageDigest,
        approvedHwModels: attestationSpec.hwModels,
        settings,
        registry: environment.registry.address,
        storageBucket: environment.storageBucket ?? teeStorageBucket,
      };
      const failures: string[] = [];
      const signature = await verifyPkiToken(token, mockTrustedRoot());
      if (!signature.ok) failures.push(`token signature: ${signature.error.message}`);
      const claims = checkClaims(decodeToken(token), expected, {
        mode: 'published',
        now: environment.now?.() ?? Math.floor(Date.now() / 1000),
      });
      for (const claim of claims) if (!claim.ok) failures.push(`${claim.claim}${claim.note ? ` (${claim.note})` : ''}`);
      return { passed: failures.length === 0, failures };
    } catch (error) {
      return { passed: false, failures: [error instanceof Error ? error.message : String(error)] };
    }
  };
}

export interface VerifiedTee {
  instancePublicKey: Hex;
  encryptionPublicKey: Hex;
  verdict: TokenVerdict;
}

/** Fetches a fresh attestation and requires it to be trusted. Throws `AttestationFailedError` otherwise. */
export async function verifyTee(
  tee: Pick<TeeClient, 'attestation'>,
  environment: AttestationEnvironment,
): Promise<VerifiedTee> {
  const attestation = await tee.attestation();
  const verdict = await attestationChecker(environment)(attestation);
  if (!verdict.trusted) throw new AttestationFailedError(verdict);
  return { instancePublicKey: attestation.instancePublicKey, encryptionPublicKey: attestation.encryptionPublicKey, verdict };
}
