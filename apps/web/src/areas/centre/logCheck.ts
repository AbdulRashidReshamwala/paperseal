import { verifyTeeSignature } from '@paperseal/crypto';
import {
  encodeMessage,
  entriesHash,
  equalBytes,
  fromHex,
  releaseEntryFromWire,
  type Hex,
} from '@paperseal/protocol';
import type { ReleaseLogResponse } from '@paperseal/tee-client';

import type { PublishedTokenResult } from '../../shared/attest';

export interface LogVerdict {
  /** Every check below passed. */
  pass: boolean;
  entriesHash: boolean;
  signature: boolean;
  token: PublishedTokenResult;
  /** The log names this exam. */
  exam: boolean;
}

/**
 * Verifies the release log: its `entriesHash` is the hash of its entries, `teeSignature` verifies
 * under `instancePublicKey` over the `releaseLog` message, and `release-token.jwt` attests that key.
 * Anything missing counts as a failure.
 */
export async function verifyReleaseLog(
  log: ReleaseLogResponse,
  expected: { examId: Hex },
  token: string | null,
  checkToken: (token: string, instancePublicKey: Hex) => Promise<PublishedTokenResult>,
): Promise<LogVerdict> {
  let hashOk = false;
  let signatureOk = false;
  try {
    hashOk = equalBytes(entriesHash(log.entries.map(releaseEntryFromWire)), fromHex(log.entriesHash));
    signatureOk = await verifyTeeSignature(
      fromHex(log.instancePublicKey),
      fromHex(log.teeSignature),
      encodeMessage('releaseLog', { examId: fromHex(log.examId), entriesHash: fromHex(log.entriesHash) }),
    );
  } catch {
    // A malformed log fails both checks.
  }
  const tokenResult: PublishedTokenResult = token
    ? await checkToken(token, log.instancePublicKey)
    : { passed: false, failures: ['release-token.jwt is not available.'] };
  const exam = log.examId.toLowerCase() === expected.examId.toLowerCase();
  return {
    pass: hashOk && signatureOk && tokenResult.passed && exam,
    entriesHash: hashOk,
    signature: signatureOk,
    token: tokenResult,
    exam,
  };
}
