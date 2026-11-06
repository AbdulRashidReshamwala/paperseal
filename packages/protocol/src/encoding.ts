import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { decodeAbiParameters, encodeAbiParameters, type AbiParameter } from 'viem';

import { fromHex, toHex, utf8ToBytes } from './bytes';
import { domainTags, limits, padding, threshold, type DomainTagName } from './constants';
import type { Hex } from './types';

/*
 * Every signed or hashed message is SHA-256(abi.encode(string tag, field, ...))
 * with standard ABI encoding (spec/api.md). Encoding is viem's; nothing here
 * writes ABI bytes by hand.
 */

/** ABI types used by the Signed Messages table. */
export type FieldType = 'bytes32' | 'uint32' | 'bytes' | 'string';

/** `key` fields are P-256 public keys: 65-byte uncompressed points, or empty when `optional`. */
type Field = readonly [name: string, type: FieldType, check?: 'publicKey' | 'optionalPublicKey'];
type Schema = readonly Field[];

/**
 * Field order and types are the Signed Messages table in spec/api.md.
 * `paperHash` is the schema of `build.saltedPaperHash`, not `build.paperHash`.
 * `shareHash` is the hash of a share, with one `bytes share` field.
 */
export const messageSchemas = {
  attestationNonce: [
    ['instancePublicKey', 'bytes', 'publicKey'],
    ['examId', 'bytes32'],
  ],
  instanceKey: [
    ['examId', 'bytes32'],
    ['encryptionPublicKey', 'bytes', 'publicKey'],
  ],
  setterOwner: [['passkeyPublicKey', 'bytes', 'publicKey']],
  registration: [
    ['derivedPublicKey', 'bytes', 'optionalPublicKey'],
    ['holderId', 'bytes'],
    ['challenge', 'bytes'],
    ['inviteTag', 'bytes32'],
  ],
  criteria: [['criteria', 'bytes']],
  approvedList: [
    ['examId', 'bytes32'],
    ['entries', 'bytes'],
  ],
  questionSubmission: [
    ['examId', 'bytes32'],
    ['challenge', 'bytes'],
    ['questionHash', 'bytes32'],
  ],
  questionReceipt: [
    ['examId', 'bytes32'],
    ['passkeyPublicKey', 'bytes', 'publicKey'],
    ['questionHash', 'bytes32'],
  ],
  build: [
    ['examId', 'bytes32'],
    ['approvedListHash', 'bytes32'],
    ['paperHash', 'bytes32'],
    ['storageManifestHash', 'bytes32'],
    ['saltedPaperHash', 'bytes32'],
    ['selected', 'uint32'],
    ['bankSize', 'uint32'],
    ['criteriaHash', 'bytes32'],
  ],
  paperHash: [
    ['seed', 'bytes32'],
    ['paper', 'bytes'],
  ],
  shareHash: [['share', 'bytes']],
  shareRelease: [
    ['examId', 'bytes32'],
    ['challenge', 'bytes'],
  ],
  releaseLog: [
    ['examId', 'bytes32'],
    ['entriesHash', 'bytes32'],
    ['filesHash', 'bytes32'],
  ],
} as const satisfies Record<DomainTagName, Schema>;

export type MessageName = keyof typeof messageSchemas;

type FieldValue<T extends FieldType> = T extends 'uint32' ? number : T extends 'string' ? string : Uint8Array;

/** The named fields of a message, typed from its schema. */
export type MessageFields<N extends MessageName> = {
  [F in (typeof messageSchemas)[N][number] as F[0]]: FieldValue<F[1]>;
};

function assertPublicKey(name: string, key: Uint8Array): void {
  if (key.length !== 65 || key[0] !== 0x04) {
    throw new RangeError(`${name} must be a 65-byte uncompressed point starting with 0x04`);
  }
}

function checkField([name, type, check]: Field, value: unknown): Uint8Array | number | string {
  if (type === 'uint32') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= 2 ** 32) {
      throw new RangeError(`${name} must be a uint32`);
    }
    return value;
  }
  if (type === 'string') {
    if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
    return value;
  }
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be bytes`);
  if (type === 'bytes32' && value.length !== 32) throw new RangeError(`${name} must be 32 bytes`);
  if (check === 'publicKey' || (check === 'optionalPublicKey' && value.length > 0)) {
    assertPublicKey(name, value);
  }
  return value;
}

/** The preimage: `abi.encode(string tag, fields...)`. */
export function encodeMessage<N extends MessageName>(name: N, fields: MessageFields<N>): Uint8Array {
  const values = fields as Record<string, unknown>;
  const schema = messageSchemas[name] as Schema;
  const params: AbiParameter[] = [{ type: 'string' }];
  const args: unknown[] = [domainTags[name]];
  for (const field of schema) {
    const value = values[field[0]];
    if (value === undefined) throw new TypeError(`${name} is missing ${field[0]}`);
    const checked = checkField(field, value);
    params.push({ type: field[1] === 'bytes' ? 'bytes' : field[1] });
    args.push(typeof checked === 'number' || typeof checked === 'string' ? checked : toHex(checked));
  }
  return fromHex(encodeAbiParameters(params, args));
}

export function hashMessage<N extends MessageName>(name: N, fields: MessageFields<N>): Uint8Array {
  return sha256(encodeMessage(name, fields));
}

/**
 * `setterOwner(passkeyPublicKey)`: the lowercase 0x hex of the message hash. It is the `owner` of a
 * setter on the approved list, so no name is ever published and anyone can recompute it.
 */
export function setterOwner(passkeyPublicKey: Uint8Array): Hex {
  return toHex(hashMessage('setterOwner', { passkeyPublicKey }));
}

/** `build.paperHash`: the plain SHA-256 of the encrypted paper file. */
export function encryptedPaperHash(encryptedPaper: Uint8Array): Uint8Array {
  return sha256(encryptedPaper);
}

/** `questionHash`: the plain SHA-256 of the question ciphertext, never of the plaintext. */
export function questionHash(ciphertext: Uint8Array): Uint8Array {
  return sha256(ciphertext);
}

/** `build.saltedPaperHash`. Plaintext is never hashed unsalted, so guesses can't be tested. */
export function saltedPaperHash(seed: Uint8Array, paper: Uint8Array): Uint8Array {
  return hashMessage('paperHash', { seed, paper });
}

/**
 * `eat_nonce` from spec/api.md: lowercase hex, no 0x prefix, of the
 * `attestationNonce` message hash.
 */
export function attestationNonce(instancePublicKey: Uint8Array, examId: Uint8Array): string {
  return toHex(hashMessage('attestationNonce', { instancePublicKey, examId })).slice(2);
}

/** `examId`: the keccak256 of the exam's human-readable name. */
export function examIdFromName(name: string): Hex {
  return toHex(keccak_256(utf8ToBytes(name)));
}

/** A drand round in a hash input: big-endian uint64. */
export function encodeRound(round: number | bigint): Uint8Array {
  const value = BigInt(round);
  if (value < 0n || value >= 1n << 64n) throw new RangeError(`${value.toString()} does not fit in 8 bytes`);
  return fromHex(`0x${value.toString(16).padStart(16, '0')}`);
}

/* ---------------------------------------------------------------- Approved List */

/** `Entry.role` in spec/api.md. */
export const roles = {
  setter: 1,
  neutral: 2,
  centreKeyHolder: 3,
  centre: 4,
} as const;
export type Role = (typeof roles)[keyof typeof roles];

export interface ApprovedListEntry {
  role: number;
  passkeyPublicKey: Uint8Array;
  /** Empty for setters, 65 bytes otherwise. */
  derivedPublicKey: Uint8Array;
  owner: string;
}

const entriesParameters = [
  {
    type: 'tuple[]',
    components: [
      { name: 'role', type: 'uint8' },
      { name: 'passkeyPublicKey', type: 'bytes' },
      { name: 'derivedPublicKey', type: 'bytes' },
      { name: 'owner', type: 'string' },
    ],
  },
] as const satisfies readonly AbiParameter[];

export class ApprovedListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovedListError';
  }
}

const isRole = (role: number): role is Role => Object.values<number>(roles).includes(role);

/** Per-entry rules: a known role, key shapes that fit it, and a non-empty owner. */
function checkEntry(entry: ApprovedListEntry, index: number): void {
  const at = `entry ${String(index)}`;
  if (!isRole(entry.role)) throw new ApprovedListError(`${at} has unknown role ${String(entry.role)}`);
  if (entry.passkeyPublicKey.length !== 65 || entry.passkeyPublicKey[0] !== 0x04) {
    throw new ApprovedListError(`${at} passkeyPublicKey must be a 65-byte uncompressed point`);
  }
  if (entry.role === roles.setter) {
    if (entry.derivedPublicKey.length !== 0) {
      throw new ApprovedListError(`${at} is a setter and must have an empty derivedPublicKey`);
    }
  } else if (entry.derivedPublicKey.length !== 65 || entry.derivedPublicKey[0] !== 0x04) {
    throw new ApprovedListError(`${at} derivedPublicKey must be a 65-byte uncompressed point`);
  }
  if (entry.owner.length === 0) throw new ApprovedListError(`${at} has an empty owner`);
}

/** A setter's owner must be the `setterOwner` hash of its own passkey public key. */
function checkSetterOwner(entry: ApprovedListEntry, index: number): void {
  if (entry.role === roles.setter && entry.owner !== setterOwner(entry.passkeyPublicKey)) {
    throw new ApprovedListError(
      `entry ${String(index)} is a setter whose owner is not the setterOwner hash of its passkey public key`,
    );
  }
}

/**
 * The list rules from spec/api.md: a setter's owner is the hash of its passkey, no repeated passkey, no repeated non-empty
 * derived key, and key-holder counts from `threshold`. Applies the per-entry
 * rules too. Order is free.
 */
export function checkApprovedList(entries: readonly ApprovedListEntry[]): void {
  entries.forEach(checkEntry);
  entries.forEach(checkSetterOwner);
  const passkeys = new Set<string>();
  const derived = new Set<string>();
  const counts = new Map<number, number>();
  for (const entry of entries) {
    const passkey = toHex(entry.passkeyPublicKey);
    if (passkeys.has(passkey)) throw new ApprovedListError('a passkey is repeated');
    passkeys.add(passkey);
    if (entry.derivedPublicKey.length > 0) {
      const key = toHex(entry.derivedPublicKey);
      if (derived.has(key)) throw new ApprovedListError('a derived key is repeated');
      derived.add(key);
    }
    counts.set(entry.role, (counts.get(entry.role) ?? 0) + 1);
  }
  const neutrals = counts.get(roles.neutral) ?? 0;
  const centres = counts.get(roles.centreKeyHolder) ?? 0;
  if (neutrals !== threshold.neutrals || centres !== threshold.centres) {
    throw new ApprovedListError(
      `expected ${String(threshold.neutrals)} neutral and ${String(threshold.centres)} centre key holders, got ${String(neutrals)} and ${String(centres)}`,
    );
  }
}

/** `abi.encode(Entry[])`. Checks each entry's shape, not the list rules. */
export function encodeApprovedList(entries: readonly ApprovedListEntry[]): Uint8Array {
  entries.forEach(checkEntry);
  return fromHex(
    encodeAbiParameters(entriesParameters, [
      entries.map((entry) => ({
        role: entry.role,
        passkeyPublicKey: toHex(entry.passkeyPublicKey),
        derivedPublicKey: toHex(entry.derivedPublicKey),
        owner: entry.owner,
      })),
    ]),
  );
}

/* ------------------------------------------------------------ Size Limits */

/**
 * Where a tuple's dynamic fields sit: `headWords` is the head length in 32-byte words, and
 * `dynamic` lists the head slots that hold an offset to a `bytes` or `string` tail.
 */
interface ElementShape {
  headWords: number;
  dynamic: readonly number[];
}

const WORD = 32;
const paddedLength = (length: number): number => Math.ceil(length / WORD) * WORD;

/** Reads a word as a number no larger than `max`; anything else fails. Allocates nothing. */
function readWord(buf: Uint8Array, at: number, max: number, fail: (message: string) => Error): number {
  if (at < 0 || at + WORD > buf.length) throw fail('layout reads past the end of the bytes');
  for (let i = 0; i < WORD - 4; i += 1) {
    if (buf[at + i] !== 0) throw fail('layout has an offset or length that is too large');
  }
  const value = new DataView(buf.buffer, buf.byteOffset + at + WORD - 4, 4).getUint32(0);
  if (value > max) throw fail('layout has an offset or length that is too large');
  return value;
}

/**
 * Checks a run of offsets that each point at a region, per "Size Limits" in spec/api.md: the first
 * starts right after the head, each starts after the one before it, and each region ends at or
 * before the next starts. `regionEnd` returns where a region ends. Returns where the last one ends.
 */
function checkOffsets(
  headStart: number,
  offsets: readonly number[],
  fail: (message: string) => Error,
  regionEnd: (start: number) => number,
): number {
  let expected = offsets.length * WORD;
  let end = headStart + expected;
  offsets.forEach((offset, index) => {
    if (index === 0 ? offset !== expected : offset < expected) {
      throw fail('layout has offsets that overlap or leave gaps');
    }
    end = regionEnd(headStart + offset);
    expected = end - headStart;
  });
  return end;
}

/** End of a `bytes` or `string` at `start`, reading its length word. */
function tailEnd(buf: Uint8Array, start: number, fail: (message: string) => Error): number {
  const length = readWord(buf, start, buf.length, fail);
  const end = start + WORD + paddedLength(length);
  if (end > buf.length) throw fail('layout has a length that runs past the end of the bytes');
  return end;
}

/** Checks an array at `start` (its length word) of tuples of one shape. Returns where it ends. */
function checkTupleArray(
  buf: Uint8Array,
  start: number,
  shape: ElementShape,
  fail: (message: string) => Error,
): number {
  const count = readWord(buf, start, Math.floor(buf.length / WORD), fail);
  const headStart = start + WORD;
  const offsets: number[] = [];
  for (let i = 0; i < count; i += 1) offsets.push(readWord(buf, headStart + i * WORD, buf.length, fail));
  if (headStart + count * WORD > buf.length) throw fail('layout has a length that runs past the end of the bytes');
  return checkOffsets(headStart, offsets, fail, (elementStart) => {
    const inner = shape.dynamic.map((slot) => readWord(buf, elementStart + slot * WORD, buf.length, fail));
    const innerEnd = checkOffsetsFrom(buf, elementStart, shape, inner, fail);
    return innerEnd;
  });
}

/** Like `checkOffsets` for a tuple's head, whose first tail starts after `headWords` words. */
function checkOffsetsFrom(
  buf: Uint8Array,
  elementStart: number,
  shape: ElementShape,
  inner: readonly number[],
  fail: (message: string) => Error,
): number {
  let expected = shape.headWords * WORD;
  let end = elementStart + expected;
  inner.forEach((offset, index) => {
    if (index === 0 ? offset !== expected : offset < expected) {
      throw fail('layout has offsets that overlap or leave gaps');
    }
    end = tailEnd(buf, elementStart + offset, fail);
    expected = end - elementStart;
  });
  return end;
}

/**
 * The layout check from "Size Limits": `abi.encode(Entry[])` is one offset word (32), then the
 * array. Runs on the raw bytes, and allocates only for the offsets it reads, which the byte
 * length already bounds.
 */
function checkEntriesLayout(encoded: Uint8Array): void {
  const fail = (message: string): ApprovedListError => new ApprovedListError(`entries ${message}`);
  if (readWord(encoded, 0, encoded.length, fail) !== WORD) throw fail('layout does not start with the array offset 32');
  checkTupleArray(encoded, WORD, { headWords: 4, dynamic: [1, 2, 3] }, fail);
}

/** `abi.encode(Criteria)`: offset 32, then a head of 3 words, whose last is the topics offset (96). */
function checkCriteriaLayout(encoded: Uint8Array): void {
  const fail = (message: string): CriteriaError => new CriteriaError(`criteria ${message}`);
  if (readWord(encoded, 0, encoded.length, fail) !== WORD) throw fail('layout does not start with the tuple offset 32');
  const tuple = WORD;
  if (readWord(encoded, tuple + 2 * WORD, encoded.length, fail) !== 3 * WORD) {
    throw fail('layout has a topics offset that is not right after the head');
  }
  checkTupleArray(encoded, tuple + 3 * WORD, { headWords: 2, dynamic: [0] }, fail);
}

const utf8Length = (text: string): number => utf8ToBytes(text).length;

/**
 * Whether `abi.encode(Entry[])` bytes are over `limits.entriesBytes` or `limits.entries`. A list over either
 * can't be read back, and a larger one may never reach a block ("Size Limits" in spec/api.md).
 */
export function entriesOverLimit(encoded: Uint8Array): boolean {
  if (encoded.length > limits.entriesBytes) return true;
  if (encoded.length < 2 * WORD) return false;
  const count = encoded.subarray(WORD, 2 * WORD).reduce((sum, byte) => sum * 256 + byte, 0);
  return count > limits.entries;
}

/**
 * Decodes `entries`, re-encodes it and rejects the list if the bytes differ,
 * then applies the list rules, as the TEE does.
 */
export function decodeApprovedList(encoded: Uint8Array): ApprovedListEntry[] {
  if (encoded.length > limits.entriesBytes) {
    throw new ApprovedListError(`entries is longer than ${String(limits.entriesBytes)} bytes`);
  }
  checkEntriesLayout(encoded);
  let entries: ApprovedListEntry[];
  try {
    const [decoded] = decodeAbiParameters(entriesParameters, toHex(encoded));
    entries = decoded.map((entry) => ({
      role: entry.role,
      passkeyPublicKey: fromHex(entry.passkeyPublicKey),
      derivedPublicKey: fromHex(entry.derivedPublicKey),
      owner: entry.owner,
    }));
  } catch (cause) {
    throw new ApprovedListError(`entries is not abi.encode(Entry[]): ${(cause as Error).message}`);
  }
  if (entries.length > limits.entries) {
    throw new ApprovedListError(`entries has more than ${String(limits.entries)} entries`);
  }
  entries.forEach((entry, index) => {
    if (utf8Length(entry.owner) > limits.ownerBytes) {
      throw new ApprovedListError(`entry ${String(index)} owner is longer than ${String(limits.ownerBytes)} bytes`);
    }
  });
  if (toHex(encodeApprovedList(entries)) !== toHex(encoded)) {
    throw new ApprovedListError('entries is not the canonical encoding');
  }
  checkApprovedList(entries);
  return entries;
}

/** The `approvedList` message hash. `postBuild` compares it with `build.approvedListHash`. */
export function approvedListHash(examId: Uint8Array, entries: Uint8Array): Uint8Array {
  return hashMessage('approvedList', { examId, entries });
}

/* ------------------------------------------------------------ Selection Criteria */

export interface Topic {
  /** Not empty and unique within the exam. */
  name: string;
  /** Questions the paper takes from this topic, at least 1. */
  questions: number;
}

export interface Criteria {
  /** The most of a topic's bank one setter can hold, from 1 to 100. */
  maxSetterPercent: number;
  /** How many times larger than its question count each topic's bank must be, at least 2. */
  minBankMultiple: number;
  /** Not empty. */
  topics: Topic[];
}

const criteriaParameters = [
  {
    type: 'tuple',
    components: [
      { name: 'maxSetterPercent', type: 'uint32' },
      { name: 'minBankMultiple', type: 'uint32' },
      {
        name: 'topics',
        type: 'tuple[]',
        components: [
          { name: 'name', type: 'string' },
          { name: 'questions', type: 'uint32' },
        ],
      },
    ],
  },
] as const satisfies readonly AbiParameter[];

export class CriteriaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CriteriaError';
  }
}

const isUint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 32;

/** Bytes set aside for the paper's JSON around its questions, from "Selection Criteria" in spec/api.md. */
const PAPER_JSON_BYTES = 1024;

/** Every rule in "Selection Criteria" in spec/api.md. */
export function checkCriteria(criteria: Criteria): void {
  const { maxSetterPercent, minBankMultiple, topics } = criteria;
  if (!isUint32(maxSetterPercent) || maxSetterPercent < 1 || maxSetterPercent > 100) {
    throw new CriteriaError('maxSetterPercent must be from 1 to 100');
  }
  if (!isUint32(minBankMultiple) || minBankMultiple < 2) {
    throw new CriteriaError('minBankMultiple must be at least 2');
  }
  if (topics.length === 0) throw new CriteriaError('topics must not be empty');
  const names = new Set<string>();
  topics.forEach(({ name, questions }, index) => {
    if (name.length === 0) throw new CriteriaError(`topic ${String(index)} has an empty name`);
    if (names.has(name)) throw new CriteriaError(`topic name ${JSON.stringify(name)} is repeated`);
    names.add(name);
    if (!isUint32(questions) || questions < 1) {
      throw new CriteriaError(`topic ${String(index)} questions must be at least 1`);
    }
  });
  const selected = selectedCount(criteria);
  if (selected >= 2 ** 32) {
    throw new CriteriaError('selected count does not fit in a uint32');
  }
  // A paper that passes Lock must always fit, so every question counts at its full padded size.
  const paperNeeds = selected * padding.questionBytes + PAPER_JSON_BYTES;
  if (paperNeeds > padding.paperBytes) {
    throw new CriteriaError(
      `questions need ${String(paperNeeds)} bytes (${String(selected)} x ${String(padding.questionBytes)} + ${String(PAPER_JSON_BYTES)}), more than paperBytes ${String(padding.paperBytes)}`,
    );
  }
}

/** The paper's `selected` count: the sum of every topic's `questions`. */
export function selectedCount(criteria: Pick<Criteria, 'topics'>): number {
  return criteria.topics.reduce((sum, topic) => sum + topic.questions, 0);
}

/** `abi.encode(Criteria)`. Rejects criteria that break the rules. */
export function encodeCriteria(criteria: Criteria): Uint8Array {
  checkCriteria(criteria);
  return fromHex(
    encodeAbiParameters(criteriaParameters, [
      {
        maxSetterPercent: criteria.maxSetterPercent,
        minBankMultiple: criteria.minBankMultiple,
        topics: criteria.topics.map(({ name, questions }) => ({ name, questions })),
      },
    ]),
  );
}

/** Decodes `criteria`, checks the rules, then re-encodes and rejects differing bytes. */
export function decodeCriteria(encoded: Uint8Array): Criteria {
  if (encoded.length > limits.criteriaBytes) {
    throw new CriteriaError(`criteria is longer than ${String(limits.criteriaBytes)} bytes`);
  }
  checkCriteriaLayout(encoded);
  let criteria: Criteria;
  try {
    const [decoded] = decodeAbiParameters(criteriaParameters, toHex(encoded));
    criteria = {
      maxSetterPercent: decoded.maxSetterPercent,
      minBankMultiple: decoded.minBankMultiple,
      topics: decoded.topics.map(({ name, questions }) => ({ name, questions })),
    };
  } catch (cause) {
    throw new CriteriaError(`criteria is not abi.encode(Criteria): ${(cause as Error).message}`);
  }
  if (criteria.topics.length > limits.topics) {
    throw new CriteriaError(`criteria has more than ${String(limits.topics)} topics`);
  }
  criteria.topics.forEach(({ name }, index) => {
    if (utf8Length(name) > limits.topicNameBytes) {
      throw new CriteriaError(`topic ${String(index)} name is longer than ${String(limits.topicNameBytes)} bytes`);
    }
  });
  if (toHex(encodeCriteria(criteria)) !== toHex(encoded)) {
    throw new CriteriaError('criteria is not the canonical encoding');
  }
  return criteria;
}

/** `criteriaHash`: the hash of the `criteria` message. */
export function criteriaHash(encodedCriteria: Uint8Array): Uint8Array {
  return hashMessage('criteria', { criteria: encodedCriteria });
}
