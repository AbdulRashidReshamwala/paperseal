import { sealQuestion } from '@paperseal/crypto';
import type { Keys } from '@paperseal/keys';
import {
  encodeQuestion,
  equalBytes,
  fromHex,
  hashMessage,
  padding,
  questionHash as hashQuestion,
  toHex,
  type Criteria,
  type Hex,
  type Question,
} from '@paperseal/protocol';
import type { StatusResponse, TeeClient } from '@paperseal/tee-client';

import type { Confirmed } from './confirm';
import { saveReceipt, verifyReceipt, type StoredReceipt } from './receipts';

/** Four bytes of the padded size hold the length. */
const LENGTH_PREFIX_BYTES = 4;
export const maxQuestionBytes = padding.questionBytes - LENGTH_PREFIX_BYTES;

export interface QuestionCheck {
  /** Bytes of the question JSON. It must fit in `limit`. */
  size: number;
  limit: number;
  error: string | null;
}

/** Client-side validation. The TEE checks again, but this tells the setter first. */
export function checkQuestion(criteria: Criteria, question: Question): QuestionCheck {
  const size = encodeQuestion(question).length;
  const check = (error: string | null): QuestionCheck => ({ size, limit: maxQuestionBytes, error });
  if (!criteria.topics.some((topic) => topic.name === question.topic)) {
    return check('Choose one of the exam topics.');
  }
  if (question.text.trim() === '') return check('Enter the question text.');
  if (size > maxQuestionBytes) {
    return check(
      `The question is ${String(size)} bytes and only ${String(maxQuestionBytes)} fit in the ${String(padding.questionBytes)} byte padded size.`,
    );
  }
  return check(null);
}

export class SubmitBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmitBlockedError';
  }
}

/** The TEE answered, but its receipt does not verify. The question may still be held by it. */
export class ReceiptInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptInvalidError';
  }
}

export interface SubmitDeps {
  keys: Pick<Keys, 'sign'>;
  tee: Pick<TeeClient, 'status' | 'questionChallenge' | 'question'>;
  credentialId: Hex;
  passkeyPublicKey: Hex;
  now?: () => number;
}

export const submitNotOpen = (stage: StatusResponse['stage']): string =>
  stage === 'submit'
    ? ''
    : `Submitting is only open at the submit stage. The TEE is at the ${stage} stage.`;

/**
 * Encrypt, sign, send and verify the receipt of one question. `confirmed` can only come from
 * `confirmTee`, so nothing is encrypted before the attestation and the list hash pass.
 */
export async function sealAndSubmit(
  deps: SubmitDeps,
  confirmed: Confirmed,
  question: Question,
): Promise<StoredReceipt> {
  const invalid = checkQuestion(confirmed.criteria, question).error;
  if (invalid) throw new SubmitBlockedError(invalid);
  const { stage } = await deps.tee.status();
  if (stage !== 'submit') throw new SubmitBlockedError(submitNotOpen(stage));

  const examId = fromHex(confirmed.examId);
  const ciphertext = await sealQuestion(confirmed.encryptionPublicKey, examId, question);
  const questionHash = hashQuestion(ciphertext);

  const { challenge } = await deps.tee.questionChallenge();
  const digest = hashMessage('questionSubmission', {
    examId,
    challenge: fromHex(challenge),
    questionHash,
  });
  const signed = await deps.keys.sign(fromHex(deps.credentialId), digest);

  const receipt = await deps.tee.question({
    passkeyPublicKey: deps.passkeyPublicKey,
    ciphertext: toHex(ciphertext),
    challenge,
    signature: toHex(signed.signature),
    authenticatorData: toHex(signed.authenticatorData),
    clientDataJSON: toHex(signed.clientDataJSON),
  });

  if (!equalBytes(fromHex(receipt.questionHash), questionHash)) {
    throw new ReceiptInvalidError('The receipt is for a different question hash than the one sent.');
  }
  const stored: StoredReceipt = {
    questionHash: receipt.questionHash,
    instancePublicKey: confirmed.instancePublicKey,
    teeSignature: receipt.teeSignature,
    sealedAt: deps.now?.() ?? Date.now(),
  };
  if (!(await verifyReceipt(confirmed.examId, deps.passkeyPublicKey, stored))) {
    throw new ReceiptInvalidError(
      'The receipt signature does not verify under the TEE instance key. It is not shown as sealed and is not kept.',
    );
  }
  saveReceipt(confirmed.examId, stored);
  return stored;
}
