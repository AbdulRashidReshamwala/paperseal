import {
  checkManifestCoverage,
  encryptedPaperHash,
  equalBytes,
  fromHex,
  parseManifest,
  storageNames,
  type Hex,
  type Manifest,
} from '@paperseal/protocol';

/*
 * Public storage, read through hashes. Nothing downloaded is trusted until its SHA-256 matches
 * the manifest, and the manifest matches the Build on-chain. This file has no decryption.
 */

export type FetchFile = (name: string) => Promise<Uint8Array>;

export class StorageVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageVerificationError';
  }
}

/** Reads `<baseUrl>/<examId>/<name>`. */
export function storageFetcher(
  baseUrl: string,
  examId: Hex,
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): FetchFile {
  const base = baseUrl.replace(/\/+$/, '');
  return async (name) => {
    const response = await fetcher(`${base}/${examId}/${name}`);
    if (!response.ok) {
      throw new StorageVerificationError(`Storage returned ${String(response.status)} for ${name}.`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

/** What the Build commits to about storage. */
export interface BuildCommitment {
  storageManifestHash: Hex;
  paperHash?: Hex;
}

export interface VerifiedManifest {
  manifest: Manifest;
  bytes: Uint8Array;
}

/** Fetches `manifest.json` and checks its hash against the Build's `storageManifestHash`. */
export async function fetchManifest(
  fetchFile: FetchFile,
  build: BuildCommitment,
  examId: Hex,
): Promise<VerifiedManifest> {
  const bytes = await fetchFile(storageNames.manifest);
  if (!equalBytes(await sha256(bytes), fromHex(build.storageManifestHash))) {
    throw new StorageVerificationError('manifest.json does not match the storage manifest hash in the Build.');
  }
  let manifest: Manifest;
  try {
    manifest = parseManifest(bytes);
  } catch (error) {
    throw new StorageVerificationError(`manifest.json is malformed: ${(error as Error).message}`);
  }
  if (manifest.examId !== examId.toLowerCase()) {
    throw new StorageVerificationError('manifest.json is for a different exam.');
  }
  return { manifest, bytes };
}

/** Fetches one listed file and checks its SHA-256 against the manifest, and `paper.bin` against the Build too. */
export async function fetchListedFile(
  fetchFile: FetchFile,
  verified: VerifiedManifest,
  build: BuildCommitment,
  name: string,
): Promise<Uint8Array> {
  const entry = verified.manifest.files.find((file) => file.name === name);
  if (!entry) throw new StorageVerificationError(`The manifest does not list ${name}.`);
  const bytes = await fetchFile(name);
  if (!equalBytes(await sha256(bytes), fromHex(entry.sha256))) {
    throw new StorageVerificationError(`${name} does not match its hash in the manifest.`);
  }
  if (name === storageNames.paper && build.paperHash !== undefined) {
    if (!equalBytes(encryptedPaperHash(bytes), fromHex(build.paperHash))) {
      throw new StorageVerificationError('paper.bin does not match the paper hash in the Build.');
    }
  }
  return bytes;
}

/** The manifest must cover every file written before the Build, one share per key holder. */
export function checkCoverage(manifest: Manifest, holders: readonly Uint8Array[]): void {
  try {
    checkManifestCoverage(manifest, holders);
  } catch (error) {
    throw new StorageVerificationError(`The manifest is incomplete: ${(error as Error).message}`);
  }
}
