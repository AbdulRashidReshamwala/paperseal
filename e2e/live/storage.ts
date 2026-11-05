import {
  approvedListHash,
  checkManifestCoverage,
  decodeApprovedList,
  encryptedPaperHash,
  equalBytes,
  fromHex,
  parseManifest,
  roles,
  storageNames,
  type Hex,
  type Manifest,
} from '@paperseal/protocol';

import { deployed } from './config';
import { retryTransient } from './util';

/* Public storage read through hashes, as in apps/web shared/storage.ts. Nothing counts until its SHA-256 matches. */

export class NotFoundError extends Error {
  constructor(name: string) {
    super(`storage has no ${name} (404)`);
    this.name = 'NotFoundError';
  }
}

export type FetchFile = (name: string) => Promise<Uint8Array>;

/** Reads `<storage>/<examId>/<name>`. A 404 is a NotFoundError, which is not retried; network trouble is. */
export function storageFetcher(examId: Hex): FetchFile {
  return (name) =>
    retryTransient(async () => {
      const response = await fetch(`${deployed.storageUrl}/${examId}/${name}`, { cache: 'no-store' });
      if (response.status === 404 || response.status === 403) throw new NotFoundError(name);
      if (!response.ok) throw Object.assign(new Error(`storage returned ${String(response.status)} for ${name}`), { status: response.status });
      return new Uint8Array(await response.arrayBuffer());
    });
}

export const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));

export interface BuildCommitment {
  storageManifestHash: Hex;
  paperHash: Hex;
  approvedListHash: Hex;
}

export interface VerifiedManifest {
  manifest: Manifest;
  bytes: Uint8Array;
}

export async function fetchManifest(fetchFile: FetchFile, build: Pick<BuildCommitment, 'storageManifestHash'>, examId: Hex): Promise<VerifiedManifest> {
  const bytes = await fetchFile(storageNames.manifest);
  if (!equalBytes(await sha256(bytes), fromHex(build.storageManifestHash))) {
    throw new Error('manifest.json does not match the storage manifest hash in the Build');
  }
  const manifest = parseManifest(bytes);
  if (manifest.examId !== examId.toLowerCase()) throw new Error('manifest.json is for a different exam');
  return { manifest, bytes };
}

export async function fetchListedFile(fetchFile: FetchFile, verified: VerifiedManifest, build: Pick<BuildCommitment, 'paperHash'>, name: string): Promise<Uint8Array> {
  const entry = verified.manifest.files.find((file) => file.name === name);
  if (!entry) throw new Error(`the manifest does not list ${name}`);
  const bytes = await fetchFile(name);
  if (!equalBytes(await sha256(bytes), fromHex(entry.sha256))) throw new Error(`${name} does not match its hash in the manifest`);
  if (name === storageNames.paper && !equalBytes(encryptedPaperHash(bytes), fromHex(build.paperHash))) {
    throw new Error('paper.bin does not match the paper hash in the Build');
  }
  return bytes;
}

/** The key holders' derived keys from the on-chain list, after checking it is the list the Build committed to. */
export function holdersFromChainList(examId: Hex, entries: Hex, build: Pick<BuildCommitment, 'approvedListHash'>): Uint8Array[] {
  if (!equalBytes(approvedListHash(fromHex(examId), fromHex(entries)), fromHex(build.approvedListHash))) {
    throw new Error('the on-chain approved list does not match the approved list hash in the Build');
  }
  return decodeApprovedList(fromHex(entries))
    .filter((entry) => entry.role === roles.neutral || entry.role === roles.centreKeyHolder)
    .map((entry) => entry.derivedPublicKey);
}

export function checkCoverage(manifest: Manifest, holders: readonly Uint8Array[]): void {
  checkManifestCoverage(manifest, holders);
}
