import { sha256 } from '@noble/hashes/sha2.js';
import { decodeAbiParameters, encodeAbiParameters, type AbiParameter } from 'viem';

import { equalBytes, fromHex, toHex } from './bytes';
import { padding } from './constants';
import type { Criteria } from './encoding';
import type { DecimalString, Hex } from './types';

/* ---------------------------------------------------------------------- Padding */

const LENGTH_BYTES = 4;

export class PaddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaddingError';
  }
}

/** "Padding" in spec/api.md: a big-endian uint32 length, the data, then zero bytes up to `size`. */
export function pad(data: Uint8Array, size: number): Uint8Array {
  if (!Number.isInteger(size) || size < LENGTH_BYTES || size > 2 ** 32 - 1) {
    throw new RangeError('size must be a uint32 of at least 4');
  }
  if (data.length > size - LENGTH_BYTES) throw new PaddingError('data does not fit in the padded size');
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, data.length, false);
  out.set(data, LENGTH_BYTES);
  return out;
}

/** Removes padding. Rejects a wrong size, a length that doesn't fit and any non-zero padding byte. */
export function unpad(padded: Uint8Array, size: number): Uint8Array {
  if (padded.length !== size) throw new PaddingError(`padded data must be ${String(size)} bytes`);
  if (size < LENGTH_BYTES) throw new PaddingError('padded data is too short');
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
  if (length > size - LENGTH_BYTES) throw new PaddingError('the length prefix does not fit');
  const end = LENGTH_BYTES + length;
  for (let i = end; i < size; i++) {
    if (padded[i] !== 0) throw new PaddingError('padding is not zero');
  }
  return padded.slice(LENGTH_BYTES, end);
}

export const padQuestion = (data: Uint8Array): Uint8Array => pad(data, padding.questionBytes);
export const unpadQuestion = (padded: Uint8Array): Uint8Array => unpad(padded, padding.questionBytes);
export const padPaper = (data: Uint8Array): Uint8Array => pad(data, padding.paperBytes);
export const unpadPaper = (padded: Uint8Array): Uint8Array => unpad(padded, padding.paperBytes);

/* --------------------------------------------------------- Questions and papers */

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

/** A question is the JSON `{"topic": string, "text": string}`. */
export interface Question {
  topic: string;
  text: string;
}

/** The paper is the JSON `{"examId": hex, "questions": Question[]}`. */
export interface Paper {
  examId: Hex;
  questions: Question[];
}

const utf8 = new TextEncoder();

function parseJson(input: Uint8Array | string, what: string): unknown {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      // A byte order mark is kept, so JSON.parse rejects it.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      throw new FormatError(`${what} is not valid UTF-8`);
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FormatError(`${what} is not valid JSON`);
  }
}

/** An object with exactly these keys, no more and no fewer. */
function exactObject(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FormatError(`${what} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    throw new FormatError(`${what} must have exactly the keys ${wanted.join(', ')}`);
  }
  return value as Record<string, unknown>;
}

function questionFrom(value: unknown, what: string, criteria?: Pick<Criteria, 'topics'>): Question {
  const object = exactObject(value, ['topic', 'text'], what);
  const { topic, text } = object;
  if (typeof topic !== 'string' || typeof text !== 'string') {
    throw new FormatError(`${what} topic and text must be strings`);
  }
  if (criteria && !criteria.topics.some((t) => t.name === topic)) {
    throw new FormatError(`${what} topic ${JSON.stringify(topic)} is not a criteria topic`);
  }
  return { topic, text };
}

/** Strict parse. With `criteria`, `topic` must name one of its topics. */
export function parseQuestion(input: Uint8Array | string, criteria?: Pick<Criteria, 'topics'>): Question {
  return questionFrom(parseJson(input, 'question'), 'question', criteria);
}

export function encodeQuestion(question: Question): Uint8Array {
  return utf8.encode(JSON.stringify(questionFrom(question, 'question')));
}

function isExamId(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
}

/**
 * Strict parse. With `criteria`, every topic must be named by it, and the paper must hold
 * exactly each topic's `questions` count.
 */
export function parsePaper(input: Uint8Array | string, criteria?: Pick<Criteria, 'topics'>): Paper {
  const object = exactObject(parseJson(input, 'paper'), ['examId', 'questions'], 'paper');
  const { examId, questions } = object;
  if (!isExamId(examId)) throw new FormatError('paper examId must be 32 bytes of lowercase 0x hex');
  if (!Array.isArray(questions)) throw new FormatError('paper questions must be an array');
  const paper: Paper = {
    examId,
    questions: questions.map((q, i) => questionFrom(q, `paper question ${String(i)}`, criteria)),
  };
  if (criteria) {
    for (const topic of criteria.topics) {
      const count = paper.questions.filter((q) => q.topic === topic.name).length;
      if (count !== topic.questions) {
        throw new FormatError(
          `paper has ${String(count)} questions for topic ${JSON.stringify(topic.name)}, expected ${String(topic.questions)}`,
        );
      }
    }
  }
  return paper;
}

/** The bytes `saltedPaperHash` covers: the paper JSON before padding. */
export function encodePaper(paper: Paper): Uint8Array {
  if (!isExamId(paper.examId)) throw new FormatError('paper examId must be 32 bytes of lowercase 0x hex');
  return utf8.encode(
    JSON.stringify({
      examId: paper.examId,
      questions: paper.questions.map((q) => questionFrom(q, 'paper question')),
    }),
  );
}

/* ---------------------------------------------------------------------- Release */

/** The `release` plaintext, sealed to `encryptionPublicKey`. */
export interface ReleasePlaintext {
  share: Uint8Array;
  signature: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
}

const releaseParameters = [
  { name: 'share', type: 'bytes' },
  { name: 'signature', type: 'bytes' },
  { name: 'authenticatorData', type: 'bytes' },
  { name: 'clientDataJSON', type: 'bytes' },
] as const satisfies readonly AbiParameter[];

/** `abi.encode(bytes share, bytes signature, bytes authenticatorData, bytes clientDataJSON)`. */
export function encodeRelease(release: ReleasePlaintext): Uint8Array {
  return fromHex(
    encodeAbiParameters(releaseParameters, [
      toHex(release.share),
      toHex(release.signature),
      toHex(release.authenticatorData),
      toHex(release.clientDataJSON),
    ]),
  );
}

/** Decodes the plaintext, then rejects bytes that differ from the canonical encoding. */
export function decodeRelease(encoded: Uint8Array): ReleasePlaintext {
  let release: ReleasePlaintext;
  try {
    const [share, signature, authenticatorData, clientDataJSON] = decodeAbiParameters(
      releaseParameters,
      toHex(encoded),
    );
    release = {
      share: fromHex(share),
      signature: fromHex(signature),
      authenticatorData: fromHex(authenticatorData),
      clientDataJSON: fromHex(clientDataJSON),
    };
  } catch (cause) {
    throw new FormatError(`release is not abi.encode(bytes, bytes, bytes, bytes): ${(cause as Error).message}`);
  }
  if (!equalBytes(encodeRelease(release), encoded)) throw new FormatError('release is not the canonical encoding');
  return release;
}

/* ------------------------------------------------------------- Release entries */

/** `ReleaseEntry` in spec/api.md, in the order the TEE received them. */
export interface ReleaseEntry {
  passkeyPublicKey: Uint8Array;
  shareHash: Uint8Array;
  round: bigint;
}

/** A release entry in JSON: hex bytes and a decimal-string round. */
export interface ReleaseEntryWire {
  passkeyPublicKey: Hex;
  shareHash: Hex;
  round: DecimalString;
}

const releaseEntriesParameters = [
  {
    type: 'tuple[]',
    components: [
      { name: 'passkeyPublicKey', type: 'bytes' },
      { name: 'shareHash', type: 'bytes32' },
      { name: 'round', type: 'uint64' },
    ],
  },
] as const satisfies readonly AbiParameter[];

export function releaseEntryFromWire(wire: ReleaseEntryWire): ReleaseEntry {
  if (!/^(0|[1-9][0-9]*)$/.test(wire.round)) throw new FormatError('round must be a decimal string');
  return { passkeyPublicKey: fromHex(wire.passkeyPublicKey), shareHash: fromHex(wire.shareHash), round: BigInt(wire.round) };
}

/** `abi.encode(ReleaseEntry[])`. */
export function encodeReleaseEntries(entries: readonly ReleaseEntry[]): Uint8Array {
  for (const entry of entries) {
    if (entry.shareHash.length !== 32) throw new RangeError('shareHash must be 32 bytes');
    if (entry.round < 0n || entry.round >= 1n << 64n) throw new RangeError('round must fit in a uint64');
  }
  return fromHex(
    encodeAbiParameters(releaseEntriesParameters, [
      entries.map((entry) => ({
        passkeyPublicKey: toHex(entry.passkeyPublicKey),
        shareHash: toHex(entry.shareHash),
        round: entry.round,
      })),
    ]),
  );
}

/** `entriesHash`: the plain SHA-256 of `abi.encode(ReleaseEntry[])`. The `releaseLog` message covers it. */
export function entriesHash(entries: readonly ReleaseEntry[]): Uint8Array {
  return sha256(encodeReleaseEntries(entries));
}

/* --------------------------------------------------------------------- Manifest */

/** One file in `manifest.json`. */
export interface ManifestFile {
  name: string;
  sha256: Hex;
  /** `derivedPublicKey` of the holder a share file is for. */
  recipient?: Hex;
  shareHash?: Hex;
}

export interface Manifest {
  examId: Hex;
  /** Sorted by `name`. */
  files: ManifestFile[];
}

const isHexOf = (value: unknown, bytes: number): value is Hex =>
  typeof value === 'string' && new RegExp(`^0x[0-9a-f]{${String(bytes * 2)}}$`).test(value);

/**
 * Strict parse of `manifest.json`: exact keys, lowercase hex of the right length, and files
 * in strictly ascending `name` order, so names are unique and one manifest has one order.
 */
export function parseManifest(input: Uint8Array | string): Manifest {
  const top = exactObject(parseJson(input, 'manifest'), ['examId', 'files'], 'manifest');
  if (!isHexOf(top.examId, 32)) throw new FormatError('manifest examId must be 32 bytes of lowercase 0x hex');
  if (!Array.isArray(top.files)) throw new FormatError('manifest files must be an array');
  const files = top.files.map((raw: unknown, i): ManifestFile => {
    const what = `manifest file ${String(i)}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new FormatError(`${what} must be a JSON object`);
    }
    const allowed = new Set(['name', 'sha256', 'recipient', 'shareHash']);
    const object = raw as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      if (!allowed.has(key)) throw new FormatError(`${what} has an unknown key ${key}`);
    }
    const { name, sha256: digest, recipient, shareHash } = object;
    if (typeof name !== 'string' || name.length === 0) throw new FormatError(`${what} needs a name`);
    if (!isHexOf(digest, 32)) throw new FormatError(`${what} sha256 must be 32 bytes of lowercase 0x hex`);
    if (recipient !== undefined && !isHexOf(recipient, 65)) {
      throw new FormatError(`${what} recipient must be a 65-byte public key`);
    }
    if (shareHash !== undefined && !isHexOf(shareHash, 32)) {
      throw new FormatError(`${what} shareHash must be 32 bytes of lowercase 0x hex`);
    }
    return {
      name,
      sha256: digest,
      ...(recipient === undefined ? {} : { recipient }),
      ...(shareHash === undefined ? {} : { shareHash }),
    };
  });
  files.forEach((file, i) => {
    const previous = files[i - 1];
    if (previous && !(previous.name < file.name)) {
      throw new FormatError('manifest files must be sorted by name, with no repeats');
    }
  });
  return { examId: top.examId, files };
}

/** `storageManifestHash`: the plain SHA-256 of the `manifest.json` bytes as stored. */
export function storageManifestHash(manifestBytes: Uint8Array): Uint8Array {
  return sha256(manifestBytes);
}

/** Storage names from "Storage" in spec/api.md. A key in a name is lowercase 0x hex. */
export const storageNames = {
  paper: 'paper.bin',
  keyPub: 'key-pub.tlock',
  token: 'token.jwt',
  manifest: 'manifest.json',
  keyPriv: 'key-priv.tlock',
  releaseLog: 'release-log.json',
  share: (derivedPublicKey: Uint8Array) => `shares/${toHex(derivedPublicKey)}.bin`,
  centreKeyPriv: (derivedPublicKey: Uint8Array) => `key-priv/${toHex(derivedPublicKey)}.bin`,
} as const;

/**
 * Checks the manifest lists every file written before the Build: the paper, `K_pub`, the token,
 * and one share per key holder, each with its `recipient` and `shareHash`. `holders` are the
 * key holders' derived public keys from the approved list.
 */
export function checkManifestCoverage(manifest: Manifest, holders: readonly Uint8Array[]): void {
  const byName = new Map(manifest.files.map((file) => [file.name, file]));
  for (const name of [storageNames.paper, storageNames.keyPub, storageNames.token]) {
    if (!byName.has(name)) throw new FormatError(`manifest does not list ${name}`);
  }
  const expected = new Set<string>([storageNames.paper, storageNames.keyPub, storageNames.token]);
  for (const holder of holders) {
    const name = storageNames.share(holder);
    expected.add(name);
    const file = byName.get(name);
    if (!file) throw new FormatError(`manifest does not list ${name}`);
    if (file.recipient !== toHex(holder) || file.shareHash === undefined) {
      throw new FormatError(`manifest entry ${name} needs its recipient and shareHash`);
    }
  }
  for (const file of manifest.files) {
    if (!expected.has(file.name)) throw new FormatError(`manifest lists an unexpected file ${file.name}`);
  }
}
