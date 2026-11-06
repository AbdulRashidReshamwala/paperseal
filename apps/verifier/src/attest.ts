import {
  checkClaims,
  checkToken,
  decodeToken,
  MalformedTokenError,
  verifyPkiToken,
  type ClaimCheck,
  type ExpectedClaims,
  type InstanceKeyResult,
  type SignatureResult,
  type TokenVerdict,
} from '@paperseal/attestation';
import type { ExamRegistry } from '@paperseal/chain';
import { verifyTeeSignature } from '@paperseal/crypto';
import { attestation, chain, encodeMessage, fromHex, type ExamSettings, type Hex } from '@paperseal/protocol';
import type { TeeClient } from '@paperseal/tee-client';

import { rootOption } from './mockMode';
import { resolveDefaults } from './runtime-config';

/**
 * The bucket the TEE was started with, which `env_override` must name, as this build and host
 * default it: `VITE_TEE_STORAGE_BUCKET`, then `config.json`. The page passes the viewer's own
 * setting instead, and an exam name's bucket record replaces that for one view. Unset, it is empty
 * and the claim fails against any real token.
 */
export const teeStorageBucket: string = resolveDefaults().storageBucket;

export type Exam = NonNullable<Awaited<ReturnType<ExamRegistry['getExam']>>>;
export type Build = NonNullable<Awaited<ReturnType<ExamRegistry['getBuild']>>>;

/** The exam settings the TEE must have been started with: the chain's values, with this viewer's registry. */
export function examSettings(exam: Exam, registry: Hex): ExamSettings {
  const s = exam.settings;
  return {
    examId: s.examId,
    examStart: Number(s.examStart),
    delta: Number(s.delta),
    lockRound: String(s.lockRound),
    unlockRound: String(s.unlockRound),
    endRound: String(s.endRound),
    criteriaHash: s.criteriaHash,
    rpcHost: s.rpcHost,
    registry,
    chainId: chain.chainId,
  };
}

interface KeyMaterial {
  instancePublicKey: Hex;
  encryptionPublicKey: Hex;
  instanceKeySignature: Hex;
}

/**
 * What a token has to say. The startup arguments come from the on-chain settings, and
 * `storageBucket` is the one environment value the operator sets. Each claim row shows what the
 * token held, so a viewer can see the difference.
 */
export function expectedClaims(
  exam: Exam,
  registry: Hex,
  examId: Hex,
  keys: Pick<KeyMaterial, 'instancePublicKey'> & Partial<KeyMaterial>,
  bucket: string = teeStorageBucket,
): ExpectedClaims {
  return {
    instancePublicKey: fromHex(keys.instancePublicKey),
    // A published token has no instance key signature. Only checkToken reads these two.
    encryptionPublicKey: fromHex(keys.encryptionPublicKey ?? '0x'),
    instanceKeySignature: fromHex(keys.instanceKeySignature ?? '0x'),
    examId: fromHex(examId),
    imageDigest: exam.imageDigest,
    approvedHwModels: attestation.hwModels,
    settings: examSettings(exam, registry),
    registry,
    storageBucket: bucket,
  };
}

export interface BuildSignatureResult {
  ok: boolean;
  error?: string;
}

/** `build.teeSignature` over the `build` message, under `build.instancePublicKey`. */
export async function checkBuildSignature(examId: Hex, build: Build): Promise<BuildSignatureResult> {
  try {
    const message = encodeMessage('build', {
      examId: fromHex(examId),
      approvedListHash: fromHex(build.approvedListHash),
      paperHash: fromHex(build.paperHash),
      storageManifestHash: fromHex(build.storageManifestHash),
      saltedPaperHash: fromHex(build.saltedPaperHash),
      selected: Number(build.selected),
      bankSize: Number(build.bankSize),
      criteriaHash: fromHex(build.criteriaHash),
      builtRound: build.builtRound,
    });
    const ok = await verifyTeeSignature(fromHex(build.instancePublicKey), fromHex(build.teeSignature), message);
    return ok ? { ok } : { ok, error: 'the Build signature does not verify under its instance key' };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export interface RecordVerdict {
  /** True only when the token signature and every claim pass. */
  verified: boolean;
  signature: SignatureResult;
  claims: ClaimCheck[];
}

/**
 * A published PKI token, checked against the chain. It is a record, so the claims run in
 * `published` mode with no expiry check, and its `eat_nonce` must bind `instancePublicKey`.
 * A published token has no instance key signature to check, because the TEE only gives that
 * with a fresh token.
 */
export async function checkRecordToken(args: {
  token: string;
  exam: Exam;
  examId: Hex;
  registry: Hex;
  instancePublicKey: Hex;
  /** The bucket the TEE must name. `teeStorageBucket` when left out. */
  bucket?: string;
  /** A DER root in place of Google's. Tests only. */
  trustedRoot?: Uint8Array;
}): Promise<RecordVerdict> {
  const { token, exam, examId, registry } = args;
  const expected = expectedClaims(exam, registry, examId, { instancePublicKey: args.instancePublicKey }, args.bucket);
  const options = {
    mode: 'published' as const,
    now: Math.floor(Date.now() / 1000),
    ...(args.trustedRoot ? { trustedRoot: args.trustedRoot } : rootOption()),
  };
  let claims: ClaimCheck[];
  try {
    claims = checkClaims(decodeToken(token), expected, options);
  } catch (error) {
    if (!(error instanceof MalformedTokenError)) throw error;
    return { verified: false, signature: { ok: false, error }, claims: [] };
  }
  const signature = await verifyPkiToken(token, options.trustedRoot);
  return { verified: signature.ok && claims.every((claim) => claim.ok), signature, claims };
}

export interface PublishedVerdict extends RecordVerdict {
  build: BuildSignatureResult;
}

/** `token.jwt`: the Build instance's record. The Build must be signed by the key it binds. */
export async function checkPublishedToken(args: {
  token: string;
  exam: Exam;
  build: Build;
  examId: Hex;
  registry: Hex;
  bucket?: string;
  trustedRoot?: Uint8Array;
}): Promise<PublishedVerdict> {
  const record = await checkRecordToken({ ...args, instancePublicKey: args.build.instancePublicKey as Hex });
  const build = await checkBuildSignature(args.examId, args.build);
  return { ...record, verified: record.verified && build.ok, build };
}

export interface FreshVerdict extends TokenVerdict {
  instancePublicKey: Hex;
}

/** A fresh token from the TEE the viewer pointed at, through checkToken, so `trusted` means all of it. */
export async function checkFreshToken(args: {
  tee: TeeClient;
  exam: Exam;
  examId: Hex;
  registry: Hex;
  bucket?: string;
  trustedRoot?: Uint8Array;
}): Promise<FreshVerdict> {
  const { token, ...keys } = await args.tee.attestation();
  const verdict = await checkToken(token, expectedClaims(args.exam, args.registry, args.examId, keys, args.bucket), {
    mode: 'live',
    now: Math.floor(Date.now() / 1000),
    ...(args.trustedRoot ? { trustedRoot: args.trustedRoot } : rootOption()),
  });
  return { ...verdict, instancePublicKey: keys.instancePublicKey };
}

export type { InstanceKeyResult };
