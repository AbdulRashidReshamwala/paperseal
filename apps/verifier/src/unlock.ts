import { verifyTeeSignature } from '@paperseal/crypto';
import {
  encodeMessage,
  entriesHash,
  fromHex,
  releaseEntryFromWire,
  threshold,
  toHex,
  type Hex,
  type ReleaseEntryWire,
} from '@paperseal/protocol';
import type { ReleaseLogResponse } from '@paperseal/tee-client';

import { sameHex, type CheckResult } from './checks';
import type { HolderRef } from './commitments';

const isHex = (value: unknown): value is Hex => typeof value === 'string' && /^0x([0-9a-f]{2})*$/.test(value);

/** Reads `release-log.json`, the `GET /v1/release/log` body, and rejects anything of another shape. */
export function parseReleaseLog(bytes: Uint8Array): ReleaseLogResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('release-log.json is not valid JSON.');
  }
  const log = raw as Partial<ReleaseLogResponse> | null;
  if (
    typeof log !== 'object' ||
    log === null ||
    !isHex(log.examId) ||
    !isHex(log.entriesHash) ||
    !isHex(log.teeSignature) ||
    !isHex(log.instancePublicKey) ||
    !Array.isArray(log.entries)
  ) {
    throw new Error('release-log.json does not have the release log shape.');
  }
  const entries = log.entries as Partial<ReleaseEntryWire>[];
  for (const entry of entries) {
    if (!isHex(entry.passkeyPublicKey) || !isHex(entry.shareHash) || typeof entry.round !== 'string') {
      throw new Error('release-log.json has a malformed entry.');
    }
  }
  return log as ReleaseLogResponse;
}

export interface LogVerdict {
  examId: CheckResult;
  /** `entriesHash` recomputed from the entries, as the plain SHA-256 of `abi.encode(ReleaseEntry[])`. */
  entriesHash: CheckResult;
  /** `teeSignature` over the `releaseLog` message, under the key given. */
  signature: CheckResult;
  error?: string;
}

/**
 * Verifies a release log. The signature check is only as good as `instancePublicKey`: pass a key
 * you have attested, or the Build's key, and say which one it was.
 */
export async function checkReleaseLog(
  log: ReleaseLogResponse,
  examId: Hex,
  /** The key to check under: the log's own, once its token has passed, or null to skip the check. */
  instancePublicKey: Hex | null,
): Promise<LogVerdict> {
  const verdict: LogVerdict = {
    examId: sameHex(log.examId, examId) ? 'pass' : 'fail',
    entriesHash: 'fail',
    // With no key to check against, the signature is not checked at all.
    signature: instancePublicKey ? 'fail' : 'absent',
  };
  try {
    const recomputed = toHex(entriesHash(log.entries.map(releaseEntryFromWire)));
    verdict.entriesHash = sameHex(recomputed, log.entriesHash) ? 'pass' : 'fail';
    if (!instancePublicKey) return verdict;
    const message = encodeMessage('releaseLog', { examId: fromHex(log.examId), entriesHash: fromHex(log.entriesHash) });
    const ok = await verifyTeeSignature(fromHex(instancePublicKey), fromHex(log.teeSignature), message);
    verdict.signature = ok ? 'pass' : 'fail';
  } catch (error) {
    verdict.error = (error as Error).message;
  }
  return verdict;
}

export interface ReleaseProgress {
  rows: { owner: string; role: number; released: boolean }[];
  /** Released keys that are not a key holder on the approved list. */
  unknown: Hex[];
  count: number;
  required: number;
}

/** Which approved key holders have released. `released` is a list of passkey public keys. */
export function releaseProgress(holders: readonly HolderRef[], released: readonly string[]): ReleaseProgress {
  const keys = new Set(released.map((key) => key.toLowerCase()));
  const known = new Set(holders.map((holder) => holder.passkeyPublicKey));
  const rows = holders.map((holder) => ({
    owner: holder.owner,
    role: holder.role,
    released: keys.has(holder.passkeyPublicKey),
  }));
  return {
    rows,
    unknown: [...keys].filter((key) => !known.has(key as Hex)) as Hex[],
    count: rows.filter((row) => row.released).length,
    required: threshold.required,
  };
}
