import type { ExamRegistry } from '@paperseal/chain';
import { verifyTeeSignature } from '@paperseal/crypto';
import {
  encodeMessage,
  entriesHash,
  equalBytes,
  filesHash,
  fromHex,
  releaseEntryFromWire,
  releaseFileFromWire,
  type Hex,
} from '@paperseal/protocol';
import type { ReleaseLogResponse, TeeClient } from '@paperseal/tee-client';

import { publishedTokenChecker, type PublishedTokenResult } from '../../shared/attest';
import { storageUrl } from '../../shared/config';
import { storageFetcher } from '../../shared/storage';

export interface LogVerdict {
  /** Every check below passed. */
  pass: boolean;
  entriesHash: boolean;
  /** `filesHash` is the hash of the listed files, in the order they are listed. */
  files: boolean;
  signature: boolean;
  token: PublishedTokenResult;
  /** The log names this exam. */
  exam: boolean;
}

/**
 * Verifies the release log: its `entriesHash` is the hash of its entries, its `filesHash` the hash
 * of its files, `teeSignature` verifies under `instancePublicKey` over the `releaseLog` message, and
 * `release-token.jwt` attests that key. Anything missing counts as a failure. The files are not
 * sorted first, because `filesHash` refuses a list the TEE could not have signed.
 */
export async function verifyReleaseLog(
  log: ReleaseLogResponse,
  expected: { examId: Hex },
  token: string | null,
  checkToken: (token: string, instancePublicKey: Hex) => Promise<PublishedTokenResult>,
): Promise<LogVerdict> {
  let hashOk = false;
  let filesOk = false;
  let signatureOk = false;
  try {
    filesOk = equalBytes(filesHash(log.files.map(releaseFileFromWire)), fromHex(log.filesHash));
  } catch {
    // A malformed list fails this check.
  }
  try {
    hashOk = equalBytes(entriesHash(log.entries.map(releaseEntryFromWire)), fromHex(log.entriesHash));
    signatureOk = await verifyTeeSignature(
      fromHex(log.instancePublicKey),
      fromHex(log.teeSignature),
      encodeMessage('releaseLog', { examId: fromHex(log.examId), entriesHash: fromHex(log.entriesHash), filesHash: fromHex(log.filesHash) }),
    );
  } catch {
    // A malformed log fails both checks.
  }
  const tokenResult: PublishedTokenResult = token
    ? await checkToken(token, log.instancePublicKey)
    : { passed: false, failures: ['release-token.jwt is not available.'] };
  const exam = log.examId.toLowerCase() === expected.examId.toLowerCase();
  return {
    pass: hashOk && filesOk && signatureOk && tokenResult.passed && exam,
    entriesHash: hashOk,
    files: filesOk,
    signature: signatureOk,
    token: tokenResult,
    exam,
  };
}

export interface CheckedLog {
  log: ReleaseLogResponse;
  verdict: LogVerdict;
}

/** Reads the release log and `release-token.jwt`, then verifies them. A log that can't be read rejects. */
export async function readCheckedLog(client: Pick<TeeClient, 'releaseLog'>, reader: ExamRegistry, examId: Hex): Promise<CheckedLog> {
  const log = await client.releaseLog();
  let token: string | null = null;
  if (storageUrl) {
    try {
      token = new TextDecoder().decode(await storageFetcher(storageUrl, examId)('release-token.jwt'));
    } catch {
      token = null;
    }
  }
  const verdict = await verifyReleaseLog(log, { examId }, token, publishedTokenChecker({ registry: reader, examId }));
  return { log, verdict };
}

/** How long an unlock waits for the log. Past this it goes on without it. */
export const UNLOCK_LOG_WAIT_MS = 3000;

/**
 * The log for an unlock, only if it verified, and null for any other outcome: a log that can't be
 * read, is not ready, fails a check or takes too long. An unlock must never wait or fail on this.
 */
export async function verifiedLogForUnlock(read: () => Promise<CheckedLog>, waitMs = UNLOCK_LOG_WAIT_MS): Promise<ReleaseLogResponse | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, waitMs);
  });
  try {
    return await Promise.race([read().then(({ log, verdict }) => (verdict.pass ? log : null)), late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
