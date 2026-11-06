import { createHash } from 'node:crypto';

import { arkiv, type ArkivWriter, type BackupPhase } from '@paperseal/arkiv';
import { checkClaims, decodeToken, MalformedTokenError, verifyPkiToken, type ClaimCheck, type ExpectedClaims } from '@paperseal/attestation';
import type { ExamRegistry } from '@paperseal/chain';
import { HPKE_ENC_BYTES, verifyTeeSignature } from '@paperseal/crypto';
import {
  attestation,
  chain,
  crypto as specCrypto,
  decodeApprovedList,
  drand,
  encodeMessage,
  entriesHash,
  equalBytes,
  filesHash,
  fromHex,
  padding,
  parseManifest,
  releaseEntryFromWire,
  roles,
  storageNames,
  toHex,
  type ExamSettings,
  type Manifest,
  type ReleaseEntryWire,
  type ReleaseFileWire,
} from '@paperseal/protocol';
import { checkCollectionPath, type CollectionFile, type PostageBatch, type SwarmClient } from '@paperseal/swarm';
import { readAge } from 'tlock-js/age/age-reader-writer.js';
import { decodeArmor, isProbablyArmored } from 'tlock-js/age/armor.js';
import type { Hash, Hex } from 'viem';

import type { BackupTarget } from './args';
import { errorText } from './output';
import { fetchStorageFile, OverCapError, releaseFiles, type Fetch } from './storage';

/*
 * `backup`, as in spec/arkiv.md "Backups", "Writing". Every file is read from public storage and
 * checked before anything is sent: the manifest against the Build's on-chain
 * `storageManifestHash`, each listed file against its `sha256`, and for `unlock` each unlock file
 * as far as anything can be checked before the end round. The release token gets the same check
 * readers apply (Google's PKI signature, and the claims bound to the on-chain exam), the release
 * log must be signed by the key it attests, `key-priv.tlock` must be sealed to `endRound`, and
 * each centre's `key-priv` file must be exactly an HPKE `keyPriv`. Every file has a size cap.
 * Any failure throws `BackupRefused`, so nothing is uploaded and nothing is written.
 */

/** A check failed, or a file is missing. Nothing was uploaded or written. */
export class BackupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupRefused';
  }
}

export type BackupRegistry = Pick<ExamRegistry, 'getBuild' | 'getApprovedListEntries' | 'getExam'>;
export type BackupSwarm = Pick<SwarmClient, 'uploadCollection' | 'download' | 'stamps'>;
export type BackupWriter = Pick<ArkivWriter, 'address' | 'mirrorBackup'>;
type Exam = NonNullable<Awaited<ReturnType<ExamRegistry['getExam']>>>;

export interface PrepareDeps {
  fetch: Fetch;
  registry: BackupRegistry;
}

/** One line per check, for the output. */
export interface Check {
  file: string;
  /**
   * `hash`: the bytes match a hash the chain or the manifest commits to. `checked`: a signature and
   * every other check passed. `unhashed`: its format checks passed, but nothing commits to its bytes.
   */
  result: 'hash' | 'checked' | 'unhashed';
  detail: string;
}

export interface BackupPlan {
  phase: BackupPhase;
  /** Why this phase: `--phase`, or which unlock files storage has. */
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

const KiB = 1024;

/** The AES-256-GCM tag at the end of an HPKE ciphertext. */
const aeadTagBytes = 16;

/** An HPKE `keyPriv` (spec/api.md "Encryption"): `enc || ciphertext`, sealing the 32-byte `K_priv`. 113 bytes. */
export const keyPrivBytes = HPKE_ENC_BYTES + specCrypto.keyBytes + aeadTagBytes;

/**
 * The most bytes the writer reads of each file. The manifest has no sizes, so a listed file is
 * capped by what it is: `paper.bin` at `padding.paperBytes` plus its nonce, seed and tag (with
 * room to spare), a PKI token at 64 KiB, and the rest (`key-pub.tlock`, shares) at a few KiB.
 */
export const sizeCaps = {
  manifest: 1024 * KiB,
  paper: padding.paperBytes + 4 * KiB,
  token: 64 * KiB,
  listed: 8 * KiB,
  releaseLog: 16 * KiB,
  keyPrivTlock: 8 * KiB,
  /** Read up to this, then held to exactly `keyPrivBytes`, so the error can say how big it was. */
  keyPriv: 4 * KiB,
} as const;

function listedCap(name: string): number {
  if (name === storageNames.paper) return sizeCaps.paper;
  if (name === storageNames.token) return sizeCaps.token;
  return sizeCaps.listed;
}

async function getFile(deps: PrepareDeps, target: BackupTarget, name: string, cap: number): Promise<Uint8Array | null> {
  try {
    return await fetchStorageFile(deps.fetch, target.storageUrl, target.examId, name, downloadTimeoutMs, cap);
  } catch (error) {
    if (error instanceof OverCapError) throw new BackupRefused(`${name} in storage is over its ${String(error.cap)}-byte cap`);
    throw new BackupRefused(`could not read ${name} from storage: ${errorText(error)}`);
  }
}

async function requireFile(deps: PrepareDeps, target: BackupTarget, name: string, cap: number, why: string): Promise<Uint8Array> {
  const bytes = await getFile(deps, target, name, cap);
  if (bytes === null) throw new BackupRefused(`storage has no ${name}, ${why}`);
  return bytes;
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

  const manifestBytes = await requireFile(deps, target, storageNames.manifest, sizeCaps.manifest, 'which the Build commits to');
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

/** `release-log.json` as the TEE writes it: exactly these keys, lowercase hex of the right length. */
export interface StrictReleaseLog {
  examId: Hex;
  entries: ReleaseEntryWire[];
  entriesHash: Hex;
  files: ReleaseFileWire[];
  filesHash: Hex;
  teeSignature: Hex;
  instancePublicKey: Hex;
}

const hexOf = (value: unknown, bytes: number): value is Hex =>
  typeof value === 'string' && value.length === 2 + 2 * bytes && /^0x[0-9a-f]*$/.test(value);

function exactKeys(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} is not a JSON object`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!keys.includes(key)) throw new Error(`${what} has an unknown field ${JSON.stringify(key)}`);
  for (const key of keys) if (!(key in object)) throw new Error(`${what} has no ${key}`);
  return object;
}

/** A strict parse of `release-log.json`, the `GET /v1/release/log` body. Throws on any other shape. */
export function parseReleaseLogStrict(bytes: Uint8Array): StrictReleaseLog {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('it is not UTF-8 JSON');
  }
  const top = exactKeys(raw, ['examId', 'entries', 'entriesHash', 'files', 'filesHash', 'teeSignature', 'instancePublicKey'], 'the release log');
  if (!hexOf(top.examId, 32)) throw new Error('its examId is not 32 bytes of lowercase 0x hex');
  if (!hexOf(top.entriesHash, 32)) throw new Error('its entriesHash is not 32 bytes of lowercase 0x hex');
  if (!hexOf(top.filesHash, 32)) throw new Error('its filesHash is not 32 bytes of lowercase 0x hex');
  if (!hexOf(top.teeSignature, 64)) throw new Error('its teeSignature is not 64 bytes of lowercase 0x hex');
  if (!hexOf(top.instancePublicKey, 65) || !top.instancePublicKey.startsWith('0x04')) {
    throw new Error('its instancePublicKey is not an uncompressed P-256 key in lowercase 0x hex');
  }
  if (!Array.isArray(top.entries)) throw new Error('its entries is not an array');
  const entries = top.entries.map((raw: unknown, i): ReleaseEntryWire => {
    const entry = exactKeys(raw, ['passkeyPublicKey', 'shareHash', 'round'], `release log entry ${String(i)}`);
    if (!hexOf(entry.passkeyPublicKey, 65)) throw new Error(`entry ${String(i)} passkeyPublicKey is not 65 bytes of lowercase 0x hex`);
    if (!hexOf(entry.shareHash, 32)) throw new Error(`entry ${String(i)} shareHash is not 32 bytes of lowercase 0x hex`);
    if (typeof entry.round !== 'string' || !/^(0|[1-9][0-9]*)$/.test(entry.round)) throw new Error(`entry ${String(i)} round is not a decimal string`);
    return { passkeyPublicKey: entry.passkeyPublicKey, shareHash: entry.shareHash, round: entry.round };
  });
  if (!Array.isArray(top.files)) throw new Error('its files is not an array');
  const files = top.files.map((raw: unknown, i): ReleaseFileWire => {
    const file = exactKeys(raw, ['name', 'sha256'], `release log file ${String(i)}`);
    if (typeof file.name !== 'string' || file.name === '') throw new Error(`file ${String(i)} name is not a string`);
    if (!hexOf(file.sha256, 32)) throw new Error(`file ${String(i)} sha256 is not 32 bytes of lowercase 0x hex`);
    return { name: file.name, sha256: file.sha256 };
  });
  return { examId: top.examId, entries, entriesHash: top.entriesHash, files, filesHash: top.filesHash, teeSignature: top.teeSignature, instancePublicKey: top.instancePublicKey };
}

/** The settings the TEE must have been started with: the chain's values, with this registry. As apps/verifier/src/attest.ts `examSettings`. */
export function examSettings(exam: Exam, registry: Hex): ExamSettings {
  const s = exam.settings;
  return {
    examId: s.examId,
    examStart: Number(s.examStart),
    delta: Number(s.delta),
    lockRound: String(s.lockRound),
    unlockRound: String(s.unlockRound),
    endRound: String(s.endRound),
    criteriaHash: s.criteriaHash,
    rpcHost: s.rpcHost,
    registry,
    chainId: chain.chainId,
  };
}

/**
 * `release-token.jwt`, checked as apps/verifier/src/attest.ts `checkRecordToken` checks it: a
 * published record, so the claims run in `published` mode with no expiry, the `eat_nonce` must
 * bind `instancePublicKey` to the exam, and the signature must chain to Google's pinned root.
 * Returns the failure, or null.
 */
export async function releaseTokenFailure(args: {
  token: string;
  exam: Exam;
  examId: Hex;
  registry: Hex;
  instancePublicKey: Hex;
  bucket: string;
}): Promise<string | null> {
  const expected: ExpectedClaims = {
    instancePublicKey: fromHex(args.instancePublicKey),
    // A published token has no instance key signature. Only checkToken reads these two.
    encryptionPublicKey: new Uint8Array(),
    instanceKeySignature: new Uint8Array(),
    examId: fromHex(args.examId),
    imageDigest: args.exam.imageDigest,
    approvedHwModels: attestation.hwModels,
    settings: examSettings(args.exam, args.registry),
    registry: args.registry,
    storageBucket: args.bucket,
  };
  let claims: ClaimCheck[];
  try {
    claims = checkClaims(decodeToken(args.token), expected, { mode: 'published', now: Math.floor(Date.now() / 1000) });
  } catch (error) {
    if (error instanceof MalformedTokenError) return error.message;
    return `its claims could not be checked: ${errorText(error)}`;
  }
  const failed = claims.filter((claim) => !claim.ok);
  if (failed.length > 0) {
    return failed
      .map((claim) => `claim ${claim.claim} is ${claim.actual === undefined ? 'missing' : JSON.stringify(claim.actual)}, want ${claim.expected}${claim.note ? ` (${claim.note})` : ''}`)
      .join('; ');
  }
  const signature = await verifyPkiToken(args.token);
  return signature.ok ? null : signature.error.message;
}

/** The drand round an armoured tlock ciphertext is sealed to. Throws unless it is exactly one quicknet tlock stanza. */
export function timelockRound(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('it is not UTF-8 text');
  }
  if (!isProbablyArmored(text.trimStart())) throw new Error('it is not an armoured age file');
  let age: ReturnType<typeof readAge>;
  try {
    age = readAge(decodeArmor(text));
  } catch (error) {
    throw new Error(`it is not an age file: ${errorText(error)}`, { cause: error });
  }
  if (age.header.version !== 'age-encryption.org/v1') throw new Error(`its age version is ${JSON.stringify(age.header.version)}`);
  if (age.header.recipients.length !== 1) throw new Error(`it has ${String(age.header.recipients.length)} recipient stanzas, not one`);
  const [stanza] = age.header.recipients as [(typeof age.header.recipients)[number]];
  if (stanza.type !== 'tlock') throw new Error(`its stanza is ${JSON.stringify(stanza.type)}, not tlock`);
  const [round, chainHash, ...rest] = stanza.args;
  if (round === undefined || chainHash === undefined || rest.length > 0) throw new Error('its tlock stanza does not have a round and a chain hash');
  if (!/^[1-9][0-9]*$/.test(round)) throw new Error(`its tlock round ${JSON.stringify(round)} is not a round number`);
  if (chainHash !== drand.chainHash) throw new Error(`it is sealed to drand chain ${chainHash}, not quicknet ${drand.chainHash}`);
  if (age.body.length === 0) throw new Error('it has no payload');
  return round;
}

/** The unlock files storage has so far, read under their caps. `missing` names any it hasn't. */
interface UnlockGathered {
  logBytes: Uint8Array;
  token: Uint8Array | null;
  tlock: Uint8Array | null;
  /** By name, sorted, one per centre (roles 3 and 4) on the on-chain approved list. */
  keyPriv: [string, Uint8Array | null][];
  missing: string[];
}

async function gatherUnlock(target: BackupTarget, deps: PrepareDeps, logBytes: Uint8Array): Promise<UnlockGathered> {
  const token = await getFile(deps, target, releaseFiles.token, sizeCaps.token);
  const tlock = await getFile(deps, target, storageNames.keyPriv, sizeCaps.keyPrivTlock);
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
  const keyPriv: [string, Uint8Array | null][] = [];
  for (const name of centres.map((key) => storageNames.centreKeyPriv(key)).sort()) {
    keyPriv.push([name, await getFile(deps, target, name, sizeCaps.keyPriv)]);
  }
  const missing = [
    ...(token === null ? [releaseFiles.token] : []),
    ...(tlock === null ? [storageNames.keyPriv] : []),
    ...keyPriv.filter(([, bytes]) => bytes === null).map(([name]) => name),
  ];
  return { logBytes, token, tlock, keyPriv, missing };
}

/** Every unlock file of spec/api.md "Storage", checked as spec/arkiv.md "Backups", "Writing" lists. */
async function unlockFiles(target: BackupTarget, deps: PrepareDeps, got: UnlockGathered): Promise<{ files: CollectionFile[]; checks: Check[] }> {
  const files: CollectionFile[] = [];
  const checks: Check[] = [];
  const refuse = (name: string, error: unknown): never => {
    throw new BackupRefused(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  };

  // release-log.json: exactly the TEE's shape, this exam's, and its entriesHash recomputes. Its signature is checked below, once the token attests its key.
  let log: StrictReleaseLog;
  try {
    log = parseReleaseLogStrict(got.logBytes);
    if (log.examId !== target.examId) throw new Error(`the release log is for exam ${log.examId}, not ${target.examId}`);
    const recomputed = toHex(entriesHash(log.entries.map(releaseEntryFromWire)));
    if (recomputed !== log.entriesHash) throw new Error(`its entries hash to ${recomputed}, not its entriesHash ${log.entriesHash}`);
  } catch (error) {
    return refuse(releaseFiles.log, error);
  }

  let exam: Exam | null;
  try {
    exam = await deps.registry.getExam(target.examId);
  } catch (error) {
    throw new BackupRefused(`could not read getExam from Sepolia: ${errorText(error)}`);
  }
  if (!exam) throw new BackupRefused(`exam ${target.examId} is not on chain in ${target.registry}, so the release token has nothing to be checked against`);

  // release-token.jwt: the readers' check, against the on-chain exam, attesting the log's key.
  if (!target.bucket) {
    throw new BackupRefused(
      `${releaseFiles.token}: the exam's storage bucket is unknown, and the token's env_override must name it; pass --bucket <name> (the TEE's STORAGE_BUCKET)`,
    );
  }
  const tokenBytes = got.token ?? refuse(releaseFiles.token, new Error('missing'));
  let tokenText: string;
  try {
    tokenText = new TextDecoder('utf-8', { fatal: true }).decode(tokenBytes).trim();
  } catch {
    return refuse(releaseFiles.token, new Error('it is not UTF-8 text'));
  }
  const registry = target.registry.toLowerCase() as Hex;
  const tokenFailure = await releaseTokenFailure({ token: tokenText, exam, examId: target.examId, registry, instancePublicKey: log.instancePublicKey, bucket: target.bucket.name });
  if (tokenFailure !== null) refuse(releaseFiles.token, new Error(`it does not attest the release log's instancePublicKey ${short(log.instancePublicKey)} for this exam: ${tokenFailure}`));

  // filesHash, recomputed from the files as listed: a list out of order or with a repeat is refused.
  let listed: Uint8Array;
  try {
    listed = filesHash(log.files.map((file) => ({ name: file.name, sha256: fromHex(file.sha256) })));
  } catch (error) {
    return refuse(releaseFiles.log, new Error(`its files can't be hashed: ${errorText(error)}`));
  }
  if (!equalBytes(listed, fromHex(log.filesHash))) refuse(releaseFiles.log, new Error('its filesHash does not match its files'));
  const listedSha = new Map(log.files.map((file) => [file.name, file.sha256]));
  /** A key-priv file must be the one the signed log lists, with its hash. */
  const listedCheck = (name: string, bytes: Uint8Array) => {
    const want = listedSha.get(name);
    if (want === undefined) refuse(name, new Error('the signed release log does not list it'));
    else if (sha256Hex(bytes) !== want) refuse(name, new Error(`its hash ${short(sha256Hex(bytes))} is not the ${short(want)} the signed release log lists`));
  };

  // The log's teeSignature, under the key the token attests.
  let signed: boolean;
  try {
    const message = encodeMessage('releaseLog', { examId: fromHex(log.examId), entriesHash: fromHex(log.entriesHash), filesHash: listed });
    signed = await verifyTeeSignature(fromHex(log.instancePublicKey), fromHex(log.teeSignature), message);
  } catch (error) {
    return refuse(releaseFiles.log, new Error(`its teeSignature could not be checked: ${errorText(error)}`));
  }
  if (!signed) refuse(releaseFiles.log, new Error(`its teeSignature does not verify under the attested instancePublicKey ${short(log.instancePublicKey)}`));

  files.push({ path: releaseFiles.log, bytes: got.logBytes });
  checks.push({
    file: releaseFiles.log,
    result: 'checked',
    detail: `exam ${short(target.examId)}, ${String(log.entries.length)} entr${log.entries.length === 1 ? 'y' : 'ies'}, no unknown fields, entriesHash and filesHash recomputed, teeSignature valid under the attested ${short(log.instancePublicKey)}`,
  });
  files.push({ path: releaseFiles.token, bytes: tokenBytes });
  checks.push({
    file: releaseFiles.token,
    result: 'checked',
    detail: `Google PKI signature; claims bound to the on-chain exam, bucket ${target.bucket.name} (${target.bucket.source}); eat_nonce attests the log's signer`,
  });

  // key-priv.tlock: the file the signed log lists, and a quicknet tlock sealed to the exam's endRound.
  const tlock = got.tlock ?? refuse(storageNames.keyPriv, new Error('missing'));
  const endRound = String(exam.settings.endRound);
  let round: string;
  try {
    round = timelockRound(tlock);
  } catch (error) {
    return refuse(storageNames.keyPriv, error);
  }
  if (round !== endRound) refuse(storageNames.keyPriv, new Error(`it is sealed to round ${round}, not the exam's endRound ${endRound}`));
  listedCheck(storageNames.keyPriv, tlock);
  files.push({ path: storageNames.keyPriv, bytes: tlock });
  checks.push({ file: storageNames.keyPriv, result: 'checked', detail: `a quicknet tlock for endRound ${endRound}, with the hash the signed release log lists` });

  // key-priv/<derivedPublicKey>.bin: one per centre, each exactly an HPKE keyPriv sealing a 32-byte key.
  for (const [name, bytes] of got.keyPriv) {
    if (bytes === null) refuse(name, new Error('missing, but there is one per approved centre (roles 3 and 4)'));
    else if (bytes.length !== keyPrivBytes) {
      refuse(name, new Error(`it is ${String(bytes.length)} bytes, not the ${String(keyPrivBytes)} of an HPKE keyPriv sealing a 32-byte key`));
    } else {
      listedCheck(name, bytes);
      files.push({ path: name, bytes });
    }
  }
  if (log.files.length !== got.keyPriv.length + 1) {
    refuse(releaseFiles.log, new Error(`it lists ${String(log.files.length)} files, not key-priv.tlock and one per approved centre (${String(got.keyPriv.length + 1)})`));
  }
  checks.push({
    file: 'key-priv/*',
    result: 'checked',
    detail: `${String(got.keyPriv.length)} file${got.keyPriv.length === 1 ? '' : 's'}, one per centre (roles 3 and 4) on the on-chain approved list, each ${String(keyPrivBytes)} bytes (enc ${String(HPKE_ENC_BYTES)} + key ${String(specCrypto.keyBytes)} + tag ${String(aeadTagBytes)}), each with the hash the signed release log lists`,
  });
  return { files, checks };
}

/** Reads and checks every file. Throws `BackupRefused` on the first failure; sends nothing. */
export async function prepareBackup(target: BackupTarget, deps: PrepareDeps): Promise<BackupPlan> {
  let phase: BackupPhase;
  let phaseReason: string;
  let unlock: UnlockGathered | undefined;
  if (target.phase === 'build') {
    phase = 'build';
    phaseReason = '--phase';
  } else {
    const logBytes = await getFile(deps, target, releaseFiles.log, sizeCaps.releaseLog);
    if (logBytes === null) {
      if (target.phase === 'unlock') throw new BackupRefused(`--phase unlock, but storage has no ${releaseFiles.log} yet`);
      phase = 'build';
      phaseReason = `storage has no ${releaseFiles.log}`;
    } else {
      unlock = await gatherUnlock(target, deps, logBytes);
      const [first] = unlock.missing;
      if (first === undefined) {
        phase = 'unlock';
        phaseReason = target.phase === 'unlock' ? '--phase' : `storage has ${releaseFiles.log} and every unlock file`;
      } else if (target.phase === 'unlock') {
        throw new BackupRefused(`--phase unlock, but storage has no ${first} yet${unlock.missing.length > 1 ? ` (and ${String(unlock.missing.length - 1)} more unlock files)` : ''}`);
      } else {
        phase = 'build';
        phaseReason = `storage has ${releaseFiles.log} but not yet ${first}${unlock.missing.length > 1 ? ` and ${String(unlock.missing.length - 1)} more unlock files` : ''}, so the unlock files wait`;
        unlock = undefined;
      }
    }
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
    const bytes = await requireFile(deps, target, entry.name, listedCap(entry.name), 'which the manifest lists');
    const got = sha256Hex(bytes);
    if (got !== entry.sha256) throw new BackupRefused(`${entry.name} hashes to ${got}, not ${entry.sha256} in the manifest`);
    files.push({ path: entry.name, bytes });
  }
  checks.push({ file: `${String(manifest.files.length)} listed files`, result: 'hash', detail: 'each matches its sha256 in the manifest, and fits its size cap' });

  if (phase === 'unlock' && unlock) {
    const checked = await unlockFiles(target, deps, unlock);
    files.push(...checked.files);
    checks.push(...checked.checks);
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
