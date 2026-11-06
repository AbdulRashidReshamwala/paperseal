import { sealQuestion } from '@paperseal/crypto';
import type { Keys } from '@paperseal/keys';
import {
  encodeQuestion,
  equalBytes,
  fromHex,
  hashMessage,
  limits,
  padding,
  questionHash as hashQuestion,
  toHex,
  type Criteria,
  type Hex,
  type Question,
} from '@paperseal/protocol';
import { TeeApiError, type StatusResponse, type TeeClient } from '@paperseal/tee-client';

import { confirmationExpired, type Confirmed } from './confirm';
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

/** The letter for an option's place: A, B, C. */
export const optionLetter = (index: number): string => String.fromCharCode(65 + index);

/**
 * Plain-words problems with each option field, by place. An option is blank, or the same as an
 * earlier one, once trimmed. `null` is a field with nothing wrong.
 */
export function optionProblems(options: readonly string[]): (string | null)[] {
  const seen = new Map<string, number>();
  return options.map((option, index) => {
    const value = option.trim();
    if (value === '') return 'Write this option, or remove it.';
    const earlier = seen.get(value);
    if (earlier !== undefined) return `The same as option ${optionLetter(earlier)}. Each option must be different.`;
    seen.set(value, index);
    return null;
  });
}

/** Client-side validation. The TEE checks again, but this tells the setter first. */
export function checkQuestion(criteria: Criteria, question: Question): QuestionCheck {
  const options = question.options;
  const invalidOptions =
    options !== undefined && (options.length < limits.questionOptionsMin || options.length > limits.questionOptionsMax
      ? `Give between ${String(limits.questionOptionsMin)} and ${String(limits.questionOptionsMax)} options.`
      : optionProblems(options).some((problem) => problem !== null)
        ? 'Fix the options marked above.'
        : null);
  // `encodeQuestion` refuses invalid options, so the size is only measured once they are fine.
  const size = invalidOptions ? 0 : encodeQuestion(question).length;
  const check = (error: string | null): QuestionCheck => ({ size, limit: maxQuestionBytes, error });
  if (!criteria.topics.some((topic) => topic.name === question.topic)) {
    return check('Choose one of the exam topics.');
  }
  if (question.text.trim() === '') return check('Enter the question text.');
  if (invalidOptions) return check(invalidOptions);
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

/**
 * The confirmation can't be relied on any more: it is older than 5 minutes, or the TEE now shows
 * different keys from the ones that were confirmed. The setter must check the TEE again.
 */
export class ConfirmationLostError extends SubmitBlockedError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmationLostError';
  }
}

/**
 * An earlier attempt at this question may have reached the TEE, and now the TEE says it already
 * holds it. The question is in the bank, but this page never got its receipt.
 */
export class AlreadyHeldError extends Error {
  readonly questionHash: Hex;
  constructor(questionHash: Hex) {
    super(
      `The TEE already holds this question (hash ${questionHash}). An earlier attempt reached it but its receipt was not received, so there is no receipt for it in this browser. It was not sent again.`,
    );
    this.name = 'AlreadyHeldError';
    this.questionHash = questionHash;
  }
}

/**
 * A question that was sealed and sent, but whose result is not known: the connection broke, or the
 * TEE sent no usable answer. Kept so a retry sends this same ciphertext, with the same
 * `questionHash`, rather than sealing a fresh one that would be stored as a second copy.
 */
export interface PendingSubmission {
  questionHash: Hex;
  ciphertext: Hex;
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
  tee: Pick<TeeClient, 'status' | 'attestation' | 'questionChallenge' | 'question'>;
  credentialId: Hex;
  passkeyPublicKey: Hex;
  /** Unix milliseconds. */
  now?: () => number;
  /**
   * The unresolved attempt for this question, kept by the caller between tries. Set before anything
   * is sent, and cleared once the outcome is known.
   */
  pending?: { current: PendingSubmission | null };
  /** Where a verified receipt is kept. By default, this browser's receipts. */
  keep?: (examId: Hex, receipt: StoredReceipt) => void;
}

export const submitNotOpen = (stage: StatusResponse['stage']): string =>
  stage === 'submit'
    ? ''
    : `Submitting is only open at the submit stage. The TEE is at the ${stage} stage.`;

/** A response from the TEE that says it did not store the question. Anything else leaves it unknown. */
const refusedByTee = (error: unknown): boolean =>
  error instanceof TeeApiError && error.status >= 400 && error.status < 500;

/**
 * Encrypt, sign, send and verify the receipt of one question. `confirmed` can only come from
 * `confirmTee`, so nothing is encrypted before the attestation and the list hash pass. It must
 * also be fresh: no older than 5 minutes, and the TEE must still show the confirmed keys.
 */
export async function sealAndSubmit(
  deps: SubmitDeps,
  confirmed: Confirmed,
  question: Question,
): Promise<StoredReceipt> {
  const invalid = checkQuestion(confirmed.criteria, question).error;
  if (invalid) throw new SubmitBlockedError(invalid);
  if (confirmationExpired(confirmed, deps.now?.() ?? Date.now())) {
    throw new ConfirmationLostError('The TEE confirmation is more than 5 minutes old. Check the TEE again before sending.');
  }
  const { stage } = await deps.tee.status();
  if (stage !== 'submit') throw new SubmitBlockedError(submitNotOpen(stage));

  // A fresh attestation must show the keys that were confirmed, or the TEE is not the one checked.
  // The token is not re-checked here: the keys are what the question is sealed to and signed against.
  const fresh = await deps.tee.attestation();
  if (
    !equalBytes(fromHex(fresh.encryptionPublicKey), confirmed.encryptionPublicKey) ||
    !equalBytes(fromHex(fresh.instancePublicKey), fromHex(confirmed.instancePublicKey))
  ) {
    throw new ConfirmationLostError(
      'The TEE now shows different keys from the ones you confirmed. Nothing was sealed. Check the TEE again.',
    );
  }

  const examId = fromHex(confirmed.examId);
  const pending = deps.pending ?? { current: null };
  const retry = pending.current !== null;
  const attempt =
    pending.current ??
    (await (async (): Promise<PendingSubmission> => {
      const sealed = await sealQuestion(confirmed.encryptionPublicKey, examId, fromHex(deps.passkeyPublicKey), question);
      return { ciphertext: toHex(sealed), questionHash: toHex(hashQuestion(sealed)) };
    })());
  const questionHash = fromHex(attempt.questionHash);

  const { challenge } = await deps.tee.questionChallenge();
  const digest = hashMessage('questionSubmission', {
    examId,
    challenge: fromHex(challenge),
    questionHash,
  });
  const signed = await deps.keys.sign(fromHex(deps.credentialId), digest);

  // Recorded just before the send. If the send is ambiguous, a retry reuses this ciphertext, so the
  // question can't be stored twice. A challenge or touch that failed earlier sent nothing.
  pending.current = attempt;
  let receipt: Awaited<ReturnType<typeof deps.tee.question>>;
  try {
    receipt = await deps.tee.question({
      passkeyPublicKey: deps.passkeyPublicKey,
      ciphertext: attempt.ciphertext,
      challenge,
      signature: toHex(signed.signature),
      authenticatorData: toHex(signed.authenticatorData),
      clientDataJSON: toHex(signed.clientDataJSON),
    });
  } catch (error) {
    if (refusedByTee(error)) {
      pending.current = null;
      if (retry && error instanceof TeeApiError && error.code === 'duplicate_question') {
        throw new AlreadyHeldError(attempt.questionHash);
      }
    }
    // Otherwise the result is unknown, and `pending` stays for the retry.
    throw error;
  }

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
  (deps.keep ?? saveReceipt)(confirmed.examId, stored);
  pending.current = null;
  return stored;
}
