import { checkToken, type ExpectedClaims, type TokenVerdict } from '@paperseal/attestation';
import type { ExamRegistry } from '@paperseal/chain';
import { verifyTeeSignature } from '@paperseal/crypto';
import {
  approvedListHash,
  attestation as attestationSpec,
  chain,
  criteriaHash,
  decodeCriteria,
  encodeMessage,
  equalBytes,
  fromHex,
  type Criteria,
  type ExamSettings,
  type Hex,
} from '@paperseal/protocol';
import type { StatusResponse, TeeClient } from '@paperseal/tee-client';

/*
 * The Confirm step of "Question Submission" in the README. Nothing may be encrypted until the
 * TEE's attestation is trusted and the list hash it signed equals the one on-chain. The only way
 * to get a `Confirmed` is to pass `confirmTee`, and `sealAndSubmit` requires one.
 */

/**
 * What the app expects from a token beyond the on-chain exam record: the bucket the TEE was
 * started with. The approved `hwmodel` values come from spec/constants.json.
 */
export interface TrustPolicy {
  storageBucket: string;
}

/** A confirmation is good for 5 minutes. After that the TEE must be checked again before anything is sealed. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** When a still-open page checks again, so a slow writer never meets the expiry above. */
export const CONFIRMATION_REFRESH_MS = 4 * 60 * 1000;

export interface ConfirmDeps {
  examId: Hex;
  /** The ExamRegistry address this app uses. The token's settings must name it. */
  registryAddress: Hex;
  tee: Pick<TeeClient, 'attestation' | 'status'>;
  chain: Pick<ExamRegistry, 'getExam' | 'getApprovedList' | 'getCriteria'>;
  policy: TrustPolicy;
  /** The real `checkToken` unless a test swaps it. */
  verifyToken?: typeof checkToken;
  /** Unix seconds. */
  now?: () => number;
  /** Unix milliseconds, for the confirmation's age. */
  nowMs?: () => number;
}

declare const confirmedBrand: unique symbol;

/** Proof that attestation and the list hash passed. Only `confirmTee` makes one. */
export interface Confirmed {
  readonly [confirmedBrand]: true;
  readonly examId: Hex;
  readonly encryptionPublicKey: Uint8Array;
  readonly instancePublicKey: Hex;
  readonly criteria: Criteria;
  readonly status: StatusResponse;
  /** Unix milliseconds when the checks passed. Expires after `CONFIRMATION_TTL_MS`. */
  readonly confirmedAt: number;
}

/** True once a confirmation is older than `CONFIRMATION_TTL_MS`, or its age can't be told. */
export function confirmationExpired(confirmed: Pick<Confirmed, 'confirmedAt'>, nowMs: number): boolean {
  const age = nowMs - confirmed.confirmedAt;
  return !(age >= 0 && age <= CONFIRMATION_TTL_MS);
}

export type ConfirmStep = 'chain' | 'attestation' | 'list';

export type ConfirmOutcome =
  | { ok: true; confirmed: Confirmed }
  | {
      ok: false;
      step: ConfirmStep;
      /** Every reason, in words, so the setter sees exactly why. */
      reasons: string[];
      verdict?: TokenVerdict;
    };

const blocked = (step: ConfirmStep, ...reasons: string[]): ConfirmOutcome => ({ ok: false, step, reasons });

const show = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text === undefined ? 'missing' : text;
};

/** One line per failed check in a verdict. */
export function verdictReasons(verdict: TokenVerdict): string[] {
  const reasons: string[] = [];
  if (!verdict.signature.ok) reasons.push(`Token signature: ${verdict.signature.error.message}`);
  if (!verdict.instanceKey.ok) {
    reasons.push(`Instance key signature: ${verdict.instanceKey.error ?? 'does not verify'}`);
  }
  for (const claim of verdict.claims) {
    if (claim.ok) continue;
    const note = claim.note ? ` (${claim.note})` : '';
    reasons.push(`Claim ${claim.claim}: expected ${claim.expected}, got ${show(claim.actual)}${note}`);
  }
  if (reasons.length === 0) reasons.push('The attestation verdict was not trusted.');
  return reasons;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function confirmTee(deps: ConfirmDeps): Promise<ConfirmOutcome> {
  const { examId, tee, chain: registry } = deps;
  const examBytes = fromHex(examId);

  // The exam record and criteria come from the chain, never from the TEE.
  let exam: Awaited<ReturnType<typeof registry.getExam>>;
  let criteria: Criteria;
  try {
    exam = await registry.getExam(examId);
    if (!exam) return blocked('chain', 'This exam is not published on-chain yet.');
    const encoded = await registry.getCriteria(examId);
    if (!encoded) return blocked('chain', 'The exam criteria could not be read from the chain.');
    const encodedBytes = fromHex(encoded);
    if (!equalBytes(criteriaHash(encodedBytes), fromHex(exam.settings.criteriaHash))) {
      return blocked('chain', 'The criteria on-chain do not match the criteria hash in the exam settings.');
    }
    criteria = decodeCriteria(encodedBytes);
  } catch (error) {
    return blocked('chain', `Could not read the exam from the chain: ${errorText(error)}`);
  }

  // Attestation, with the token's expected values taken from the chain.
  let attestation: Awaited<ReturnType<typeof tee.attestation>>;
  try {
    attestation = await tee.attestation();
  } catch (error) {
    return blocked('attestation', `Could not fetch the TEE attestation: ${errorText(error)}`);
  }
  const { settings } = exam;
  const examSettings: ExamSettings = {
    examId,
    examStart: Number(settings.examStart),
    delta: Number(settings.delta),
    lockRound: settings.lockRound.toString(),
    unlockRound: settings.unlockRound.toString(),
    endRound: settings.endRound.toString(),
    criteriaHash: settings.criteriaHash,
    rpcHost: settings.rpcHost,
    registry: deps.registryAddress,
    chainId: chain.chainId,
  };
  let verdict: TokenVerdict;
  try {
    const expected: ExpectedClaims = {
      instancePublicKey: fromHex(attestation.instancePublicKey),
      encryptionPublicKey: fromHex(attestation.encryptionPublicKey),
      instanceKeySignature: fromHex(attestation.instanceKeySignature),
      examId: examBytes,
      imageDigest: exam.imageDigest,
      approvedHwModels: attestationSpec.hwModels,
      settings: examSettings,
      registry: deps.registryAddress,
      storageBucket: deps.policy.storageBucket,
    };
    verdict = await (deps.verifyToken ?? checkToken)(attestation.token, expected, {
      mode: 'live',
      now: deps.now?.() ?? Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    return blocked('attestation', `The attestation token could not be checked: ${errorText(error)}`);
  }
  if (!verdict.trusted) return { ok: false, step: 'attestation', reasons: verdictReasons(verdict), verdict };

  // The list hash the TEE signed must be the one on-chain.
  let status: StatusResponse;
  try {
    status = await tee.status();
  } catch (error) {
    return blocked('list', `Could not read the TEE status: ${errorText(error)}`);
  }
  const list = status.approvedList;
  if (!list) return blocked('list', 'The TEE has not published a signed approved list yet.');
  if (list.examId.toLowerCase() !== examId.toLowerCase()) {
    return blocked('list', 'The TEE list is for a different exam.');
  }
  let listHash: Uint8Array;
  try {
    listHash = approvedListHash(fromHex(list.examId), fromHex(list.entries));
    if (!equalBytes(listHash, fromHex(list.hash))) {
      return blocked('list', 'The list hash the TEE reports does not match the list it sent.');
    }
    const message = encodeMessage('approvedList', { examId: fromHex(list.examId), entries: fromHex(list.entries) });
    const signed = await verifyTeeSignature(fromHex(attestation.instancePublicKey), fromHex(list.teeSignature), message).catch(
      () => false,
    );
    if (!signed) return blocked('list', 'The TEE signature on the approved list is invalid.');
  } catch (error) {
    return blocked('list', `The TEE approved list is malformed: ${errorText(error)}`);
  }
  let onChain: Awaited<ReturnType<typeof registry.getApprovedList>>;
  try {
    onChain = await registry.getApprovedList(examId);
  } catch (error) {
    return blocked('list', `Could not read the approved list from the chain: ${errorText(error)}`);
  }
  if (!onChain) return blocked('list', 'The approved list is not posted on-chain yet.');
  if (!equalBytes(fromHex(onChain.listHash), listHash)) {
    return blocked(
      'list',
      `List hash mismatch: the TEE signed ${toHash(listHash)}, but the chain has ${onChain.listHash}. Do not submit.`,
    );
  }

  return {
    ok: true,
    confirmed: {
      examId,
      encryptionPublicKey: fromHex(attestation.encryptionPublicKey),
      instancePublicKey: attestation.instancePublicKey,
      criteria,
      status,
      confirmedAt: deps.nowMs?.() ?? Date.now(),
    } as Confirmed,
  };
}

const toHash = (bytes: Uint8Array): string => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
