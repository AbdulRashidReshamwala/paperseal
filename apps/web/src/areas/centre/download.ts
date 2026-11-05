import {
  approvedListHash,
  decodeApprovedList,
  equalBytes,
  fromHex,
  roles,
  storageNames,
  type Hex,
  type Manifest,
} from '@paperseal/protocol';

import {
  checkCoverage,
  fetchListedFile,
  fetchManifest,
  StorageVerificationError,
  type FetchFile,
} from '../../shared/storage';

/** The three files a centre fetches ahead of the exam, each already checked. */
export interface Downloaded {
  manifest: Manifest;
  /** `paper.bin`, matching the manifest and the Build's `paperHash`. */
  paper: Uint8Array;
  /** `key-pub.tlock`, matching the manifest. It is armoured text. */
  keyPubTlock: string;
  /** What was checked, for display. */
  checks: { label: string; detail: string }[];
}

export interface DownloadContext {
  examId: Hex;
  fetchFile: FetchFile;
  readBuild: () => Promise<{
    approvedListHash: Hex;
    paperHash: Hex;
    storageManifestHash: Hex;
  } | null>;
  /** `abi.encode(Entry[])` from ApprovedListPosted, for the manifest coverage check. */
  readListEntries: () => Promise<Hex | null>;
}

/**
 * Downloads `manifest.json`, `paper.bin` and `key-pub.tlock` and checks every hash against the
 * Build on-chain: the manifest against `storageManifestHash`, then each file against the
 * manifest, and `paper.bin` against `paperHash`. The manifest must also list one share per key
 * holder on the on-chain approved list. Throws `StorageVerificationError` on any mismatch.
 */
export async function downloadPaperFiles(context: DownloadContext): Promise<Downloaded> {
  const { examId, fetchFile } = context;
  const build = await context.readBuild();
  if (!build) throw new StorageVerificationError('No paper has been committed on-chain yet.');
  const checks: Downloaded['checks'] = [];

  const verified = await fetchManifest(fetchFile, build, examId);
  checks.push({ label: storageNames.manifest, detail: 'matches the storage manifest hash in the Build' });

  const entries = await context.readListEntries();
  if (!entries) throw new StorageVerificationError('The approved list is not on-chain, so the manifest cannot be checked.');
  if (!equalBytes(approvedListHash(fromHex(examId), fromHex(entries)), fromHex(build.approvedListHash))) {
    throw new StorageVerificationError('The on-chain approved list does not match the approved list hash in the Build.');
  }
  let holders: Uint8Array[];
  try {
    holders = decodeApprovedList(fromHex(entries))
      .filter((entry) => entry.role === roles.neutral || entry.role === roles.centreKeyHolder)
      .map((entry) => entry.derivedPublicKey);
  } catch (error) {
    throw new StorageVerificationError(`The on-chain approved list is malformed: ${(error as Error).message}`);
  }
  checkCoverage(verified.manifest, holders);
  checks.push({ label: 'Manifest coverage', detail: `lists the paper, K_pub, the token and ${String(holders.length)} shares` });

  const paper = await fetchListedFile(fetchFile, verified, build, storageNames.paper);
  checks.push({ label: storageNames.paper, detail: 'matches the manifest and the paper hash in the Build' });

  const keyPub = await fetchListedFile(fetchFile, verified, build, storageNames.keyPub);
  checks.push({ label: storageNames.keyPub, detail: 'matches the manifest' });

  return {
    manifest: verified.manifest,
    paper,
    keyPubTlock: new TextDecoder().decode(keyPub),
    checks,
  };
}
