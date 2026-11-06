import { createHash } from 'node:crypto';

import { arkiv, type ArkivWriter, type BackupPhase } from '@paperseal/arkiv';
import type { ExamRegistry } from '@paperseal/chain';
import {
  attestationNonce,
  decodeApprovedList,
  entriesHash,
  equalBytes,
  fromHex,
  parseManifest,
  releaseEntryFromWire,
  roles,
  storageNames,
  toHex,
  type Manifest,
  type ReleaseEntryWire,
} from '@paperseal/protocol';
import { checkCollectionPath, type CollectionFile, type PostageBatch, type SwarmClient } from '@paperseal/swarm';
import type { Hash, Hex } from 'viem';

import type { BackupTarget } from './args';
import { readReleaseLog } from './mirror';
import { errorText } from './output';
import { fetchStorageFile, releaseFiles, type Fetch } from './storage';

/*
 * `backup`, as in spec/arkiv.md "Backups", "Writing". Every file is read from public storage and
 * checked before anything is sent: the manifest against the Build's on-chain
 * `storageManifestHash`, each listed file against its `sha256`, and for `unlock` the release log
 * and the unlock files spec/api.md "Storage" lists. Any failure throws `BackupRefused`, so nothing
 * is uploaded and nothing is written. Only then is the collection uploaded and the row written.
 *
 * Nothing here verifies a signature: like the rest of the relay it copies public evidence, and
 * readers check every file they take from a backup exactly as if the bucket had served it.
 */

/** A check failed, or a file is missing. Nothing was uploaded or written. */
export class BackupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupRefused';
  }
}

export type BackupRegistry = Pick<ExamRegistry, 'getBuild' | 'getApprovedListEntries'>;
export type BackupSwarm = Pick<SwarmClient, 'uploadCollection' | 'download' | 'stamps'>;
export type BackupWriter = Pick<ArkivWriter, 'address' | 'mirrorBackup'>;

export interface PrepareDeps {
  fetch: Fetch;
  registry: BackupRegistry;
}

/** One line per check, for the output. */
export interface Check {
  file: string;
  /** `hash`: the bytes match a hash the chain or the manifest commits to. `checked`: other checks passed. `unhashed`: nothing commits to its bytes. */
  result: 'hash' | 'checked' | 'unhashed';
  detail: string;
}

export interface BackupPlan {
  phase: BackupPhase;
  /** Why this phase: `--phase`, or whether storage has `release-log.json`. */
  phaseReason: string;
  /** In upload order: `manifest.json`, the files it lists, then the unlock files. */
  files: CollectionFile[];
  manifestBytes: Uint8Array;
  /** SHA-256 of `manifest.json`, lowercase `0x` hex. Equal to the Build's `storageManifestHash`. */
  manifestHash: Hex;
  checks: Check[];
}

export const sha256Hex = (bytes: Uint8Array): Hex => `0x${createHash('sha256').update(bytes).digest('hex')}`;

const short = (hex: string) => (hex.length > 20 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex);

/** `paper.bin` is padded to `padding.paperBytes` (1 MiB), so a slow link gets longer than the relay's usual 20 s. */
const downloadTimeoutMs = 180_000;

async function getFile(deps: PrepareDeps, target: BackupTarget, name: string): Promise<Uint8Array | null> {
  try {
    return await fetchStorageFile(deps.fetch, target.storageUrl, target.examId, name, downloadTimeoutMs);
  } catch (error) {
    throw new BackupRefused(`could not read ${name} from storage: ${errorText(error)}`);
  }
}

async function requireFile(deps: PrepareDeps, target: BackupTarget, name: string, why: string): Promise<Uint8Array> {
  const bytes = await getFile(deps, target, name);
  if (bytes === null) throw new BackupRefused(`storage has no ${name}, ${why}`);
  return bytes;
}

/** The PKI token's `eat_nonce`, as a list. Reads the payload only: the signature is not checked. */
export function tokenNonces(jwt: Uint8Array): string[] {
  const parts = new TextDecoder().decode(jwt).trim().split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('it is not a three-part JWT');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    throw new Error('its payload is not JSON');
  }
  const nonce = (payload as { eat_nonce?: unknown } | null)?.eat_nonce;
  if (typeof nonce === 'string') return [nonce];
  if (Array.isArray(nonce) && nonce.every((n) => typeof n === 'string')) return nonce;
  throw new Error('it has no eat_nonce');
}

/** The batch the upload is stamped with: it must be on this node and usable. Throws `BackupRefused`. */
export async function checkBatch(swarm: Pick<SwarmClient, 'stamps'>, batchId: string): Promise<PostageBatch> {
  let batches: PostageBatch[];
  try {
    batches = await swarm.stamps();
  } catch (error) {
    throw new BackupRefused(`could not list the Bee node's postage batches: ${errorText(error)}`);
  }
  const batch = batches.find((b) => b.batchId === batchId);
  if (!batch) throw new BackupRefused(`the Bee node has no postage batch ${batchId} (see swarm-status, or buy-stamp)`);
  if (!batch.usable) throw new BackupRefused(`postage batch ${batchId} is not usable yet; Bee waits for confirmations after a purchase`);
  if (batch.ttlSeconds <= 0) throw new BackupRefused(`postage batch ${batchId} has expired`);
  return batch;
}

async function checkManifest(target: BackupTarget, deps: PrepareDeps) {
  let build: Awaited<ReturnType<BackupRegistry['getBuild']>>;
  try {
    build = await deps.registry.getBuild(target.examId);
  } catch (error) {
    throw new BackupRefused(`could not read getBuild from Sepolia: ${errorText(error)}`);
  }
  if (!build) throw new BackupRefused(`exam ${target.examId} has no Build on chain in ${target.registry}, so nothing commits to its files`);
  const expected = build.storageManifestHash.toLowerCase();

  const manifestBytes = await requireFile(deps, target, storageNames.manifest, 'which the Build commits to');
  const manifestHash = sha256Hex(manifestBytes);
  if (manifestHash !== expected) {
    throw new BackupRefused(`${storageNames.manifest} hashes to ${manifestHash}, not the Build's storageManifestHash ${expected}`);
  }
  let manifest: Manifest;
  try {
    manifest = parseManifest(manifestBytes);
  } catch (error) {
    throw new BackupRefused(`${storageNames.manifest} does not parse: ${errorText(error)}`);
  }
  if (manifest.examId !== target.examId) throw new BackupRefused(`${storageNames.manifest} is for exam ${manifest.examId}, not ${target.examId}`);
  return { manifestBytes, manifestHash, manifest };
}

/** The unlock files of spec/api.md "Storage", checked as far as anything commits to them. */
async function unlockFiles(target: BackupTarget, deps: PrepareDeps, logBytes: Uint8Array): Promise<{ files: CollectionFile[]; checks: Check[] }> {
  const files: CollectionFile[] = [];
  const checks: Check[] = [];

  // release-log.json: this exam's, and its entriesHash is the hash of its entries. The TEE signature is for readers.
  const log = readReleaseLog(logBytes, target.examId);
  if ('refused' in log) throw new BackupRefused(`${releaseFiles.log}: ${log.refused}`);
  let entries: ReleaseEntryWire[];
  try {
    entries = (JSON.parse(new TextDecoder().decode(logBytes)) as { entries: ReleaseEntryWire[] }).entries;
    const recomputed = toHex(entriesHash(entries.map(releaseEntryFromWire)));
    if (recomputed !== log.entriesHash) throw new Error(`its entries hash to ${recomputed}, not its entriesHash ${log.entriesHash}`);
  } catch (error) {
    throw new BackupRefused(`${releaseFiles.log}: ${error instanceof Error ? error.message : String(error)}`);
  }
  files.push({ path: releaseFiles.log, bytes: logBytes });
  checks.push({
    file: releaseFiles.log,
    result: 'checked',
    detail: `exam ${short(target.examId)}, ${String(log.entries)} entr${log.entries === 1 ? 'y' : 'ies'}, entriesHash recomputed; its teeSignature is left to readers`,
  });

  // release-token.jwt: its eat_nonce must bind the log's signer to this exam. The signature is for readers.
  const tokenBytes = await requireFile(deps, target, releaseFiles.token, 'which attests the key that signed the release log');
  const nonce = attestationNonce(fromHex(log.instancePublicKey), fromHex(target.examId));
  let nonces: string[];
  try {
    nonces = tokenNonces(tokenBytes);
  } catch (error) {
    throw new BackupRefused(`${releaseFiles.token}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!nonces.includes(nonce)) {
    throw new BackupRefused(`${releaseFiles.token}: its eat_nonce does not bind the release log's instancePublicKey ${short(log.instancePublicKey)} to this exam`);
  }
  files.push({ path: releaseFiles.token, bytes: tokenBytes });
  checks.push({ file: releaseFiles.token, result: 'checked', detail: 'eat_nonce binds the release log\'s signer to this exam; its signature is left to readers' });

  // key-priv.tlock and key-priv/<derivedPublicKey>.bin: nothing commits to their bytes (tee/internal/storage
  // IsUnlockFile: "the Build commits to none of them"). They are in the spec's unlock list, so they are
  // backed up; a reader authenticates each by its own means (timelock, HPKE to the centre's key).
  const tlock = await requireFile(deps, target, storageNames.keyPriv, 'which unlock writes');
  files.push({ path: storageNames.keyPriv, bytes: tlock });
  checks.push({ file: storageNames.keyPriv, result: 'unhashed', detail: 'no hash commits to it; in spec/api.md\'s unlock list, so backed up' });

  let listBytes: Hex | null;
  try {
    listBytes = await deps.registry.getApprovedListEntries(target.examId);
  } catch (error) {
    throw new BackupRefused(`could not read the approved list from Sepolia: ${errorText(error)}`);
  }
  if (listBytes === null) throw new BackupRefused('the exam has no approved list on chain, so its centres are unknown');
  let centres: Uint8Array[];
  try {
    centres = decodeApprovedList(fromHex(listBytes))
      .filter((entry) => entry.role === roles.centreKeyHolder || entry.role === roles.centre)
      .map((entry) => entry.derivedPublicKey);
  } catch (error) {
    throw new BackupRefused(`the on-chain approved list does not decode: ${errorText(error)}`);
  }
  if (centres.length === 0) throw new BackupRefused('the approved list has no centres (roles 3 and 4), so there are no key-priv files to back up');
  const names = centres.map((key) => storageNames.centreKeyPriv(key)).sort();
  for (const name of names) {
    files.push({ path: name, bytes: await requireFile(deps, target, name, 'one per approved centre (roles 3 and 4)') });
  }
  checks.push({
    file: 'key-priv/*',
    result: 'unhashed',
    detail: `${String(names.length)} file${names.length === 1 ? '' : 's'}, one per centre (roles 3 and 4) on the on-chain approved list; no hash commits to them; in spec/api.md's unlock list, so backed up`,
  });
  return { files, checks };
}

/** Reads and checks every file. Throws `BackupRefused` on the first failure; sends nothing. */
export async function prepareBackup(target: BackupTarget, deps: PrepareDeps): Promise<BackupPlan> {
  const logBytes = await getFile(deps, target, releaseFiles.log);
  let phase: BackupPhase;
  let phaseReason: string;
  if (target.phase !== undefined) {
    phase = target.phase;
    phaseReason = '--phase';
    if (phase === 'unlock' && logBytes === null) throw new BackupRefused(`--phase unlock, but storage has no ${releaseFiles.log} yet`);
  } else {
    phase = logBytes === null ? 'build' : 'unlock';
    phaseReason = logBytes === null ? `storage has no ${releaseFiles.log}` : `storage has ${releaseFiles.log}`;
  }

  const { manifestBytes, manifestHash, manifest } = await checkManifest(target, deps);
  const files: CollectionFile[] = [{ path: storageNames.manifest, bytes: manifestBytes }];
  const checks: Check[] = [{ file: storageNames.manifest, result: 'hash', detail: `${manifestHash}, the Build's storageManifestHash on Sepolia` }];

  for (const entry of manifest.files) {
    try {
      checkCollectionPath(entry.name);
    } catch (error) {
      throw new BackupRefused(`the manifest lists ${JSON.stringify(entry.name)}, which can't be a collection path: ${errorText(error)}`);
    }
    const bytes = await requireFile(deps, target, entry.name, 'which the manifest lists');
    const got = sha256Hex(bytes);
    if (got !== entry.sha256) throw new BackupRefused(`${entry.name} hashes to ${got}, not ${entry.sha256} in the manifest`);
    files.push({ path: entry.name, bytes });
  }
  checks.push({ file: `${String(manifest.files.length)} listed files`, result: 'hash', detail: 'each matches its sha256 in the manifest' });

  if (phase === 'unlock' && logBytes !== null) {
    const unlock = await unlockFiles(target, deps, logBytes);
    files.push(...unlock.files);
    checks.push(...unlock.checks);
  }

  return { phase, phaseReason, files, manifestBytes, manifestHash, checks };
}

export interface RunDeps {
  swarm: Pick<SwarmClient, 'uploadCollection' | 'download'>;
  writer: BackupWriter;
}

export type ReadBack = { result: 'match' } | { result: 'mismatch'; detail: string } | { result: 'missing' } | { result: 'failed'; detail: string };

export interface BackupResult {
  reference: string;
  row: { written: boolean; entityKey: Hex; txHash?: Hash } | { error: string };
  readBack: ReadBack;
}

/** Uploads the checked files as one collection, writes the row, then reads `manifest.json` back. */
export async function uploadBackup(target: BackupTarget, plan: BackupPlan, deps: RunDeps): Promise<BackupResult> {
  // Throws before anything is written if the upload fails.
  const { reference } = await deps.swarm.uploadCollection(plan.files, { batchId: target.batchId, deferred: false });

  let row: BackupResult['row'];
  try {
    const written = await deps.writer.mirrorBackup({
      examId: target.examId,
      registry: target.registry,
      phase: plan.phase,
      swarmRef: reference,
      swarmNetwork: arkiv.swarm.network,
      manifestHash: plan.manifestHash,
      files: plan.files.length,
      batchId: target.batchId,
    });
    row = { written: written.written, entityKey: written.entityKey, ...(written.txHash ? { txHash: written.txHash } : {}) };
  } catch (error) {
    row = { error: errorText(error) };
  }

  let readBack: ReadBack;
  try {
    const bytes = await deps.swarm.download(reference, storageNames.manifest);
    if (bytes === null) readBack = { result: 'missing' };
    else if (equalBytes(bytes, plan.manifestBytes)) readBack = { result: 'match' };
    else readBack = { result: 'mismatch', detail: `${String(bytes.length)} bytes hashing to ${sha256Hex(bytes)}, not ${String(plan.manifestBytes.length)} bytes hashing to ${plan.manifestHash}` };
  } catch (error) {
    readBack = { result: 'failed', detail: errorText(error) };
  }
  return { reference, row, readBack };
}

export const readBackUrl = (swarmUrl: string, reference: string): string => `${swarmUrl.replace(/\/+$/, '')}/bzz/${reference}/${storageNames.manifest}`;

export function planLines(plan: BackupPlan): string[] {
  const bytes = plan.files.reduce((sum, file) => sum + file.bytes.length, 0);
  return [
    `phase     ${plan.phase} (${plan.phaseReason})`,
    ...plan.checks.map((c) => `  ${c.result.padEnd(9)} ${c.file}: ${c.detail}`),
    `files     ${String(plan.files.length)} (${String(bytes)} bytes), all checked`,
  ];
}

export const batchCheckLine = (batch: PostageBatch): string =>
  `batch     ${batch.batchId} usable, depth ${String(batch.depth)}, utilization ${String(batch.utilization)}/${String(2 ** (batch.depth - batch.bucketDepth))}, ttl ${ttlText(batch.ttlSeconds)}`;

export function resultLines(result: BackupResult, swarmUrl: string, links: { entity: (key: Hex) => string; tx: (hash: Hash) => string }): string[] {
  const lines = [`uploaded  reference ${result.reference}`, `          ${readBackUrl(swarmUrl, result.reference)}`];
  if ('error' in result.row) lines.push(`row       FAILED: ${result.row.error}`, '          the upload is on Swarm; run backup again to write the row');
  else {
    lines.push(`row       ${result.row.written ? 'written' : 'skipped (this writer already has a row for this exam, registry, phase and reference)'}`);
    lines.push(`          entity ${result.row.entityKey}  ${links.entity(result.row.entityKey)}`);
    if (result.row.txHash) lines.push(`          tx     ${result.row.txHash}  ${links.tx(result.row.txHash)}`);
  }
  const rb = result.readBack;
  lines.push(
    rb.result === 'match'
      ? `read-back manifest.json from Swarm matches the bytes uploaded`
      : rb.result === 'missing'
        ? 'read-back MISSING: the node has no manifest.json in this collection'
        : `read-back ${rb.result === 'mismatch' ? 'MISMATCH' : 'FAILED'}: ${rb.detail}`,
  );
  return lines;
}

export function backupFailed(result: BackupResult): boolean {
  return 'error' in result.row || result.readBack.result !== 'match';
}

export function ttlText(seconds: number): string {
  if (seconds <= 0) return 'expired';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return days > 0 ? `${String(days)}d ${String(hours)}h` : `${String(hours)}h ${String(Math.floor((seconds % 3600) / 60))}m`;
}
