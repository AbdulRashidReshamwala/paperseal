import type { ExamRegistry } from '@paperseal/chain';
import type { Hex } from '@paperseal/protocol';
import type { TeeClient } from '@paperseal/tee-client';

import { AttestationFailedError, verifyTee } from '../../shared/attest';
import { PublishBlockedError } from './publishFlow';

/*
 * The gate in front of posting the approved list. The list slot is write-once, so a list composed
 * from the wrong TEE's registrations, or for an exam the browser only remembers from earlier, can
 * never be taken back. Before posting is allowed, the TEE must pass attestation for this exam
 * against the chain, be at the Onboard stage, and the exam must be one that is really published.
 */

type Exam = NonNullable<Awaited<ReturnType<ExamRegistry['getExam']>>>;

/** What the list will be written for, as read from the chain and the attested TEE. */
export interface PostTarget {
  examId: Hex;
  exam: Exam;
  /** The attested TEE instance whose registrations the list was composed from. */
  instancePublicKey: Hex;
  stage: 'onboard';
}

export type PostGate =
  | { state: 'checking' }
  | { state: 'ok'; target: PostTarget }
  | { state: 'blocked'; reason: string };

/**
 * Runs every check, and throws `PublishBlockedError` with the reason in words if any fails. It is
 * run when the screen opens and again right before the post, so a result that has gone stale
 * can't be posted on.
 */
export async function checkPostTarget(input: {
  tee: Pick<TeeClient, 'attestation' | 'status'>;
  registry: Pick<ExamRegistry, 'getExam' | 'getApprovedList' | 'address'>;
  examId: Hex;
}): Promise<PostTarget> {
  const { tee, registry, examId } = input;
  const exam = await registry.getExam(examId);
  if (!exam) {
    throw new PublishBlockedError(
      'The selected exam is not published on ExamRegistry, so the pointer to it is stale. Publish the exam, or select the right one. Nothing was posted.',
    );
  }
  if (await registry.getApprovedList(examId)) {
    throw new PublishBlockedError('An approved list is already posted for this exam. It is write-once and cannot be replaced.');
  }
  let verified: Awaited<ReturnType<typeof verifyTee>>;
  try {
    verified = await verifyTee(tee, { registry, examId });
  } catch (error) {
    if (error instanceof AttestationFailedError) {
      throw new PublishBlockedError(
        `This is not the TEE for this exam. ${error.message} The approved list is write-once, so nothing can be posted until the attestation passes.`,
      );
    }
    throw new PublishBlockedError(`The TEE could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { stage } = await tee.status();
  if (stage !== 'onboard') {
    throw new PublishBlockedError(
      `The TEE is at the ${stage} stage, not onboard. A list posted now would not be the one it onboards, so it is not allowed.`,
    );
  }
  return { examId, exam, instancePublicKey: verified.instancePublicKey, stage };
}
