import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { decodeAbiParameters, encodeAbiParameters, type AbiParameter } from 'viem';

import { fromHex, toHex, utf8ToBytes } from './bytes';
import { domainTags, threshold, type DomainTagName } from './constants';
import type { Hex } from './types';

/*
 * Every signed or hashed message is SHA-256(abi.encode(string tag, field, ...))
 * with standard ABI encoding (spec/api.md). Encoding is viem's; nothing here
 * writes ABI bytes by hand.
 */

/** ABI types used by the Signed Messages table. */
export type FieldType = 'bytes32' | 'uint32' | 'bytes';

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
  registration: [
    ['derivedPublicKey', 'bytes', 'optionalPublicKey'],
    ['holderId', 'bytes'],
    ['challenge', 'bytes'],
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
  ],
} as const satisfies Record<DomainTagName, Schema>;

export type MessageName = keyof typeof messageSchemas;

type FieldValue<T extends FieldType> = T extends 'uint32' ? number : Uint8Array;

/** The named fields of a message, typed from its schema. */
export type MessageFields<N extends MessageName> = {
  [F in (typeof messageSchemas)[N][number] as F[0]]: FieldValue<F[1]>;
};

function assertPublicKey(name: string, key: Uint8Array): void {
  if (key.length !== 65 || key[0] !== 0x04) {
    throw new RangeError(`${name} must be a 65-byte uncompressed point starting with 0x04`);
  }
}

function checkField([name, type, check]: Field, value: unknown): Uint8Array | number {
  if (type === 'uint32') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= 2 ** 32) {
      throw new RangeError(`${name} must be a uint32`);
    }
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
    args.push(typeof checked === 'number' ? checked : toHex(checked));
  }
  return fromHex(encodeAbiParameters(params, args));
}

export function hashMessage<N extends MessageName>(name: N, fields: MessageFields<N>): Uint8Array {
  return sha256(encodeMessage(name, fields));
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

/**
 * The list rules from spec/api.md: no repeated passkey, no repeated non-empty
 * derived key, and key-holder counts from `threshold`. Applies the per-entry
 * rules too. Order is free.
 */
export function checkApprovedList(entries: readonly ApprovedListEntry[]): void {
  entries.forEach(checkEntry);
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

/**
 * Decodes `entries`, re-encodes it and rejects the list if the bytes differ,
 * then applies the list rules, as the TEE does.
 */
export function decodeApprovedList(encoded: Uint8Array): ApprovedListEntry[] {
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
  if (selectedCount(criteria) >= 2 ** 32) {
    throw new CriteriaError('selected count does not fit in a uint32');
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
  if (toHex(encodeCriteria(criteria)) !== toHex(encoded)) {
    throw new CriteriaError('criteria is not the canonical encoding');
  }
  return criteria;
}

/** `criteriaHash`: the hash of the `criteria` message. */
export function criteriaHash(encodedCriteria: Uint8Array): Uint8Array {
  return hashMessage('criteria', { criteria: encodedCriteria });
}
