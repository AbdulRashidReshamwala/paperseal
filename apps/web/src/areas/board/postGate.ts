import type { ExamRegistry } from '@paperseal/chain';
import type { Hex } from '@paperseal/protocol';
import type { TeeClient } from '@paperseal/tee-client';

import { AttestationFailedError, verifyTee } from '../../shared/attest';
import { withDetails } from './details';
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
      'This exam is not on the public record, so the list cannot be posted. Publish the exam, or open the right one. Nothing was posted.',
    );
  }
  if (await registry.getApprovedList(examId)) {
    throw new PublishBlockedError('The list of people is already posted for this exam. It cannot be replaced.');
  }
  let verified: Awaited<ReturnType<typeof verifyTee>>;
  try {
    verified = await verifyTee(tee, { registry, examId });
  } catch (error) {
    if (error instanceof AttestationFailedError) {
      throw new PublishBlockedError(
        withDetails(
          'Paper Seal could not confirm it is ready for this exam, so the list is not posted. Wait a minute and try again. If it keeps happening, contact whoever runs Paper Seal.',
          error.message,
        ),
      );
    }
    throw new PublishBlockedError(
      withDetails(
        'Paper Seal could not be reached, so the list is not posted. Wait a minute and try again.',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  const { stage } = await tee.status();
  if (stage !== 'onboard') {
    throw new PublishBlockedError(
      withDetails('Paper Seal is not ready for the list yet, so nothing was posted. Wait a minute and try again.', `Stage: ${stage}.`),
    );
  }
  return { examId, exam, instancePublicKey: verified.instancePublicKey, stage };
}
