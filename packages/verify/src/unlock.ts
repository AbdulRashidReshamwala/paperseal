import { verifyTeeSignature } from '@paperseal/crypto';
import {
  encodeMessage,
  entriesHash,
  filesHash,
  fromHex,
  releaseEntryFromWire,
  releaseFileFromWire,
  storageNames,
  threshold,
  toHex,
  type ApprovedListEntry,
  type Hex,
  type ReleaseEntryWire,
  type ReleaseFileWire,
} from '@paperseal/protocol';
import type { ReleaseLogResponse } from '@paperseal/tee-client';

import { sameHex, type CheckResult } from './checks';
import { isCentre, type HolderRef } from './commitments';
import { fileSha256, type StorageReader } from './storage';

const isHex = (value: unknown): value is Hex => typeof value === 'string' && /^0x([0-9a-f]{2})*$/.test(value);
const isHash = (value: unknown): value is Hex => isHex(value) && value.length === 66;

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
    !isHash(log.filesHash) ||
    !isHex(log.teeSignature) ||
    !isHex(log.instancePublicKey) ||
    !Array.isArray(log.entries) ||
    !Array.isArray(log.files)
  ) {
    throw new Error('release-log.json does not have the release log shape.');
  }
  const entries = log.entries as Partial<ReleaseEntryWire>[];
  for (const entry of entries) {
    if (!isHex(entry.passkeyPublicKey) || !isHex(entry.shareHash) || typeof entry.round !== 'string') {
      throw new Error('release-log.json has a malformed entry.');
    }
  }
  for (const file of log.files as Partial<ReleaseFileWire>[]) {
    if (typeof file.name !== 'string' || !isHash(file.sha256)) {
      throw new Error('release-log.json has a malformed file.');
    }
  }
  return log as ReleaseLogResponse;
}

export interface LogVerdict {
  examId: CheckResult;
  /** `entriesHash` recomputed from the entries, as the plain SHA-256 of `abi.encode(ReleaseEntry[])`. */
  entriesHash: CheckResult;
  /**
   * `filesHash` recomputed from the files, as they stand: a list out of order or with a repeated
   * name is refused rather than sorted, so it fails.
   */
  filesHash: CheckResult;
  /** `teeSignature` over the `releaseLog` message, under the key given. */
  signature: CheckResult;
  error?: string;
}

/** `filesHash` of the files as listed, or null if they are not a list `filesHash` covers. */
function recomputedFilesHash(log: ReleaseLogResponse): Hex | null {
  try {
    return toHex(filesHash(log.files.map(releaseFileFromWire)));
  } catch {
    return null;
  }
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
    filesHash: 'fail',
    // With no key to check against, the signature is not checked at all.
    signature: instancePublicKey ? 'fail' : 'absent',
  };
  try {
    const recomputed = toHex(entriesHash(log.entries.map(releaseEntryFromWire)));
    verdict.entriesHash = sameHex(recomputed, log.entriesHash) ? 'pass' : 'fail';
    const recomputedFiles = recomputedFilesHash(log);
    verdict.filesHash = recomputedFiles !== null && sameHex(recomputedFiles, log.filesHash) ? 'pass' : 'fail';
    if (!instancePublicKey) return verdict;
    const message = encodeMessage('releaseLog', {
      examId: fromHex(log.examId),
      entriesHash: fromHex(log.entriesHash),
      filesHash: fromHex(log.filesHash),
    });
    const ok = await verifyTeeSignature(fromHex(instancePublicKey), fromHex(log.teeSignature), message);
    verdict.signature = ok ? 'pass' : 'fail';
  } catch (error) {
    verdict.error = (error as Error).message;
  }
  return verdict;
}

/** One key file the log lists, compared with the stored file. `owner` is the centre it is for. */
export interface ReleaseFileReport {
  name: string;
  owner?: string;
  /** The hash the log lists. */
  sha256: Hex;
  /** `pass`: the stored file has that hash. `absent`: storage did not answer, which is never a pass. */
  result: CheckResult;
  problem?: 'removed' | 'changed' | { unreadable: string };
}

export interface ReleaseFilesReport {
  /** Below the threshold, with no files listed yet: nothing is unlocked, so nothing is wrong. */
  pending: boolean;
  /** The log's names against the approved list. `absent` with no list to compare with. */
  names: CheckResult;
  /** Names the list calls for that the log does not list. `owner` is unset for `key-priv.tlock`. */
  missing: { name: string; owner?: string }[];
  /** Names the log lists that the list does not call for. */
  extra: string[];
  files: ReleaseFileReport[];
  /** The whole comparison. Only `pass` means every file was seen and matched. */
  check: CheckResult;
}

/** Every unlock file the list calls for, and the centre each is for: exactly what the log must name. */
export function expectedReleaseFiles(entries: readonly ApprovedListEntry[]): Map<string, string | undefined> {
  const centres = entries.filter(isCentre);
  return new Map<string, string | undefined>([
    [storageNames.keyPriv, undefined],
    ...centres.map((entry): [string, string] => [storageNames.centreKeyPriv(entry.derivedPublicKey), entry.owner]),
  ]);
}

async function compareStored(file: ReleaseFileWire, owner: string | undefined, storage: StorageReader): Promise<ReleaseFileReport> {
  const named = { name: file.name, sha256: file.sha256, ...(owner === undefined ? {} : { owner }) };
  try {
    const bytes = await storage.get(file.name);
    if (!bytes) return { ...named, result: 'fail', problem: 'removed' };
    return sameHex(fileSha256(bytes), file.sha256) ? { ...named, result: 'pass' } : { ...named, result: 'fail', problem: 'changed' };
  } catch (error) {
    return { ...named, result: 'absent', problem: { unreadable: (error as Error).message } };
  }
}

/**
 * Compares a log's `files` with the approved list and with storage. Only a log whose signature and
 * token passed says anything about the files, so check that first. Pass the list from the chain,
 * or null if there is none: the stored files are still compared, and the result can't be a pass.
 */
export async function checkReleaseFiles(
  log: ReleaseLogResponse,
  entries: readonly ApprovedListEntry[] | null,
  storage: StorageReader,
): Promise<ReleaseFilesReport> {
  if (log.files.length === 0 && log.entries.length < threshold.required) {
    return { pending: true, names: 'absent', missing: [], extra: [], files: [], check: 'absent' };
  }
  const expected = entries ? expectedReleaseFiles(entries) : null;
  const listed = new Set(log.files.map((file) => file.name));
  const missing = [...(expected ?? [])]
    .filter(([name]) => !listed.has(name))
    .map(([name, owner]) => ({ name, ...(owner === undefined ? {} : { owner }) }));
  const extra = expected ? log.files.map((file) => file.name).filter((name) => !expected.has(name)) : [];
  // An extra name has already failed, and there is nothing it should be compared with.
  const files = await Promise.all(
    log.files.filter((file) => !extra.includes(file.name)).map((file) => compareStored(file, expected?.get(file.name), storage)),
  );
  const names: CheckResult = !expected ? 'absent' : missing.length + extra.length === 0 ? 'pass' : 'fail';
  const results = [names, ...files.map((file) => file.result)];
  const check: CheckResult = results.includes('fail') ? 'fail' : results.includes('absent') ? 'absent' : 'pass';
  return { pending: false, names, missing, extra, files, check };
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
