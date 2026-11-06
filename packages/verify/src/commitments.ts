import {
  checkManifestCoverage,
  decodeApprovedList,
  fromHex,
  parseManifest,
  roles,
  storageManifestHash,
  toHex,
  type ApprovedListEntry,
  type Hex,
  type Manifest,
} from '@paperseal/protocol';

import type { Build } from './attest';
import { sameHex, type CheckResult } from './checks';

/** Key holders are the roles with a share: neutral parties and centres that hold a key. */
export const isHolder = (entry: ApprovedListEntry) =>
  entry.role === roles.neutral || entry.role === roles.centreKeyHolder;

/** Centres get their own copy of the key at unlock, whether or not they hold a part of it. */
export const isCentre = (entry: ApprovedListEntry) =>
  entry.role === roles.centreKeyHolder || entry.role === roles.centre;

export interface HolderRef {
  owner: string;
  role: number;
  passkeyPublicKey: Hex;
  derivedPublicKey: Hex;
}

export function holdersOf(entries: readonly ApprovedListEntry[]): HolderRef[] {
  return entries.filter(isHolder).map((entry) => ({
    owner: entry.owner,
    role: entry.role,
    passkeyPublicKey: toHex(entry.passkeyPublicKey),
    derivedPublicKey: toHex(entry.derivedPublicKey),
  }));
}

/** The approved list the chain holds, or null if it is absent or does not decode. */
export function approvedEntries(encoded: Hex | null): ApprovedListEntry[] | null {
  if (!encoded) return null;
  try {
    return decodeApprovedList(fromHex(encoded));
  } catch {
    return null;
  }
}

export interface ManifestFileReport {
  name: string;
  sha256: Hex;
  recipient?: Hex;
  /** Whether a `recipient` is a key holder on the approved list. Absent with no list or no recipient. */
  recipientOnList: CheckResult | null;
}

export type ManifestReport =
  | { kind: 'malformed'; hash: Hex; hashCheck: CheckResult; error: string }
  | {
      kind: 'parsed';
      hash: Hex;
      /** `storageManifestHash` from the Build, compared with the plain SHA-256 of these bytes. */
      hashCheck: CheckResult;
      examIdCheck: CheckResult;
      /** Lists every file written before the Build, with one share per holder on the approved list. */
      coverage: { check: CheckResult; error?: string };
      files: ManifestFileReport[];
      manifest: Manifest;
    };

/** Checks `manifest.json` as fetched. Each result is `absent` when the chain has nothing to compare yet. */
export function checkManifest(
  bytes: Uint8Array,
  context: { examId: Hex; build: Build | null; entries: ApprovedListEntry[] | null },
): ManifestReport {
  const hash = toHex(storageManifestHash(bytes));
  const hashCheck: CheckResult = context.build
    ? sameHex(hash, context.build.storageManifestHash)
      ? 'pass'
      : 'fail'
    : 'absent';
  let manifest: Manifest;
  try {
    manifest = parseManifest(bytes);
  } catch (error) {
    return { kind: 'malformed', hash, hashCheck, error: (error as Error).message };
  }
  const holders = context.entries ? holdersOf(context.entries) : null;
  const holderKeys = new Set(holders?.map((holder) => holder.derivedPublicKey));
  let coverage: { check: CheckResult; error?: string } = { check: 'absent' };
  if (holders) {
    try {
      checkManifestCoverage(
        manifest,
        holders.map((holder) => fromHex(holder.derivedPublicKey)),
      );
      coverage = { check: 'pass' };
    } catch (error) {
      coverage = { check: 'fail', error: (error as Error).message };
    }
  }
  return {
    kind: 'parsed',
    hash,
    hashCheck,
    examIdCheck: sameHex(manifest.examId, context.examId) ? 'pass' : 'fail',
    coverage,
    manifest,
    files: manifest.files.map((file) => ({
      name: file.name,
      sha256: file.sha256,
      ...(file.recipient ? { recipient: file.recipient } : {}),
      recipientOnList: !file.recipient || !holders ? null : holderKeys.has(file.recipient) ? 'pass' : 'fail',
    })),
  };
}
