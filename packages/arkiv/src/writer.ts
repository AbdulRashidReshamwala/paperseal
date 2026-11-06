import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
  type WalletArkivClient,
} from '@arkiv-network/sdk';
import { asc, eq, MAX_LIMIT } from '@arkiv-network/sdk/query';
import { addr, MAX_ENTITY_BYTES, MAX_STRING_BYTES, u64 } from '@arkiv-network/sdk/schema';
import {
  getAddress,
  hexToBytes,
  isAddressEqual,
  isHex,
  sha256,
  stringToBytes,
  type Account,
  type Address,
  type Hash,
  type Hex,
} from 'viem';

import { arkivChain, arkivTransport, examIdColumn, type ArkivConnection } from './client';
import { allPages } from './pages';
import {
  examSchema,
  participantSchema,
  relayHeartbeatSchema,
  releaseLogSchema,
  releaseTokenSchema,
} from './schemas';
import { arkiv } from './spec';

export interface ArkivWriterOptions extends ArkivConnection {
  /** The writer, which the code calls the relay. Its address is what readers trust. */
  account: Account | Address;
  /**
   * A wallet client to write rows with, such as one built from a wagmi connection. Defaults to one
   * built from `account` and the connection. Evidence rows need only `createEntity`. `upsertExam`
   * needs `patchEntity` to change a row, and `mirrorParticipants` uses `executeBatch` when given.
   */
  walletClient?:
    | (Pick<WalletArkivClient, 'createEntity'> & Partial<Pick<WalletArkivClient, 'patchEntity' | 'executeBatch'>>)
    | undefined;
}

/** What to mirror, and the exam it belongs to. `body` is the evidence's exact bytes. */
export interface MirrorInput {
  examId: Hex;
  registry: Address;
  /** The registry's chain, `chain.chainId` in spec/constants.json. */
  chainId: number | bigint;
  body: Uint8Array;
}

/** `written: false` means this writer already has the row, and `entityKey` is that row. */
export interface MirrorResult {
  written: boolean;
  entityKey: Hex;
  txHash?: Hash;
}

/** What a heartbeat says: the newest log this writer has seen, and the TEE stage it last read. */
export interface HeartbeatInput {
  examId: Hex;
  registry: Address;
  /** Not a column: a heartbeat has no `chainId`. Accepted so callers can pass their exam as is. */
  chainId?: number | bigint | undefined;
  /** The newest log's `entriesHash`, or null if this writer has seen none. */
  entriesHash: string | null;
  /** The TEE stage this writer last read, or null. */
  stage: string | null;
}

/** How far an exam has got on chain: `ExamCreated`, then `ApprovedListPosted`, then `BuildPosted`. */
export type ExamStage = 'published' | 'listed' | 'built';

/** The stages in order. A row's stage only ever moves forward. */
export const examStages: readonly ExamStage[] = ['published', 'listed', 'built'];

/**
 * One exam, from the registry's events (spec/arkiv.md, "Exam Index"). Hashes are null before the
 * event that carries them. `name` must already have passed every check of "Exam Names" in
 * spec/api.md and resolve to this exam and registry; this writer doesn't check it.
 */
export interface ExamIndexInput {
  examId: Hex;
  registry: Address;
  /** The registry's `board()`. */
  board: Address;
  chainId: number | bigint;
  stage: ExamStage;
  /** `T`, in Unix seconds. */
  examStart: number | bigint;
  /** The block of `ExamCreated`. */
  createdBlock: number | bigint;
  criteriaHash: Hex;
  /** From `ApprovedListPosted`, or null before it. */
  approvedListHash: Hex | null;
  /** From `BuildPosted`, or null before it. */
  paperHash: Hex | null;
  /** The exam's checked ENS name, or null. */
  name: string | null;
}

/** `unchanged` means this writer's row already said all of it, so nothing was sent. */
export interface UpsertExamResult {
  action: 'created' | 'patched' | 'unchanged';
  entityKey: Hex;
  txHash?: Hash;
}

/**
 * One approved-list entry, the shape `decodeApprovedList` in packages/protocol returns. Pass only
 * entries of a list that decoded and passed the list rules there.
 */
export interface ParticipantEntry {
  role: number;
  passkeyPublicKey: Uint8Array;
  /** Empty for a setter. */
  derivedPublicKey: Uint8Array;
  /** For a setter, already its `setterOwner` hash. */
  owner: string;
}

export interface MirrorParticipantsInput {
  examId: Hex;
  registry: Address;
  entries: readonly ParticipantEntry[];
}

export interface MirrorParticipantsResult {
  /** The rows this call created, in list order. */
  written: { passkeyKeyHash: string; entityKey: Hex }[];
  /** The entries this writer already had a row for. */
  skipped: { passkeyKeyHash: string; entityKey: Hex }[];
  /** One per transaction sent. */
  txHashes: Hash[];
}

/** The `role` column for list roles 1 to 4 ("Approved List" in spec/api.md). */
export const participantRoles: Readonly<Record<number, string>> = {
  1: 'setter',
  2: 'neutral',
  3: 'centre-holder',
  4: 'centre',
};

/**
 * Creates per participant transaction. A list has at most 512 entries (`limits.entries` in
 * spec/constants.json), and one transaction may carry at most 2^24 gas (EIP-7825), so a long list
 * goes in several.
 */
export const participantBatchSize = 32;

/** The input can't be mirrored. Thrown before anything is sent. */
export class MirrorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MirrorInputError';
  }
}

const hash32 = /^0x[0-9a-fA-F]{64}$/;

/** All `bytes` values of one create share this budget, and `body` is the only one. */
function checkBody(body: Uint8Array): void {
  if (body.length === 0) throw new MirrorInputError('body is empty');
  if (body.length > MAX_ENTITY_BYTES) {
    throw new MirrorInputError(
      `body is ${String(body.length)} bytes, over Arkiv's ${String(MAX_ENTITY_BYTES)}-byte limit`,
    );
  }
}

/**
 * Just enough of a release log to fill its columns. Its signature is not checked here: readers
 * check every body, so a bad log can't make a check pass, and the TEE is the source of truth.
 */
function parseReleaseLog(body: Uint8Array, examId: string): { entriesHash: string; released: number } {
  let log: unknown;
  try {
    log = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new MirrorInputError('release log body is not UTF-8 JSON');
  }
  if (typeof log !== 'object' || log === null) throw new MirrorInputError('release log is not an object');
  const { examId: logExamId, entriesHash, entries } = log as Record<string, unknown>;
  if (typeof logExamId !== 'string' || logExamId.toLowerCase() !== examId) {
    throw new MirrorInputError('release log examId does not match the exam');
  }
  if (typeof entriesHash !== 'string' || !hash32.test(entriesHash)) {
    throw new MirrorInputError('release log entriesHash is not 32 bytes of hex');
  }
  if (!Array.isArray(entries)) throw new MirrorInputError('release log entries is not an array');
  return { entriesHash: entriesHash.toLowerCase(), released: entries.length };
}

/** A token body is a compact JWT: three base64url parts. This catches mirroring the wrong file. */
function checkToken(body: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(text)) {
    throw new MirrorInputError('release token body is not a compact JWT');
  }
}

/** The `instanceKeyHash` column: SHA-256 of the 65-byte uncompressed P-256 key, lowercase hex. */
export function instanceKeyHash(instancePublicKey: Hex): string {
  if (!isHex(instancePublicKey, { strict: true })) {
    throw new MirrorInputError('instancePublicKey is not hex');
  }
  const key = hexToBytes(instancePublicKey);
  if (key.length !== 65 || key[0] !== 0x04) {
    throw new MirrorInputError('instancePublicKey is not a 65-byte uncompressed P-256 point');
  }
  return sha256(key).toLowerCase();
}

/** A `str` column holds at most `MAX_STRING_BYTES` of UTF-8. */
function checkStr(value: string, what: string): string {
  const length = stringToBytes(value).length;
  if (length > MAX_STRING_BYTES) {
    throw new MirrorInputError(`${what} is ${String(length)} bytes, over Arkiv's ${String(MAX_STRING_BYTES)}-byte str limit`);
  }
  return value;
}

/** A 32-byte hash column, lowercase, or `''` for null. */
function hashColumn(value: Hex | null, what: string): string {
  if (value === null) return '';
  if (!hash32.test(value)) throw new MirrorInputError(`${what} is not 32 bytes of hex`);
  return value.toLowerCase();
}

/** The `passkeyKeyHash` and `derivedKeyHash` columns: SHA-256 of the key bytes, lowercase hex. */
const keyHash = (key: Uint8Array): string => (key.length === 0 ? '' : sha256(key).toLowerCase());

/** The values of an exam row, as plain values, for comparing with a row and building a write. */
interface ExamColumns {
  board: Address;
  chainId: bigint;
  stage: ExamStage;
  examStart: bigint;
  createdBlock: bigint;
  criteriaHash: string;
  approvedListHash: string;
  paperHash: string;
  name: string;
}

function examColumns(input: ExamIndexInput): ExamColumns {
  if (!examStages.includes(input.stage)) throw new MirrorInputError(`stage ${String(input.stage)} is not one of ${examStages.join(', ')}`);
  const approvedListHash = hashColumn(input.approvedListHash, 'approvedListHash');
  const paperHash = hashColumn(input.paperHash, 'paperHash');
  // Each stage has exactly the hashes of the events before it.
  const rank = examStages.indexOf(input.stage);
  if ((approvedListHash !== '') !== rank >= 1) {
    throw new MirrorInputError(`a ${input.stage} exam ${rank >= 1 ? 'needs' : 'has no'} approvedListHash`);
  }
  if ((paperHash !== '') !== rank >= 2) {
    throw new MirrorInputError(`a ${input.stage} exam ${rank >= 2 ? 'needs' : 'has no'} paperHash`);
  }
  const criteriaHash = hashColumn(input.criteriaHash, 'criteriaHash');
  if (criteriaHash === '') throw new MirrorInputError('criteriaHash is required');
  return {
    board: getAddress(input.board),
    chainId: BigInt(input.chainId),
    stage: input.stage,
    examStart: BigInt(input.examStart),
    createdBlock: BigInt(input.createdBlock),
    criteriaHash,
    approvedListHash,
    paperHash,
    name: checkStr(input.name ?? '', 'name'),
  };
}

export function createArkivWriter(options: ArkivWriterOptions) {
  const { account } = options;
  const address = getAddress(typeof account === 'string' ? account : account.address);
  const chain = arkivChain(options.accessKey);
  const transport = arkivTransport(options);
  const client = createPublicClient({ chain, transport });
  const wallet = options.walletClient ?? createWalletClient({ chain, transport, account });

  /** Rows are readonly, extendable by anyone, and live `lifetimeDays`. */
  const createOptions = () => ({
    expiration: ExpirationTime.fromDays(arkiv.lifetimeDays),
    flags: { readonly: true, permissionlessExtension: true },
  });

  /** Writes the log unless this writer already has a row for its `entriesHash`. */
  async function mirrorReleaseLog(input: MirrorInput): Promise<MirrorResult> {
    checkBody(input.body);
    const examId = examIdColumn(input.examId);
    const registry = addr(getAddress(input.registry));
    const { entriesHash, released } = parseReleaseLog(input.body, examId);

    // Keyed by exam and registry too: an empty log has the same entriesHash in every exam.
    const { entities } = await client
      .select({ $key: true })
      .from(releaseLogSchema)
      .where(eq('examId', examId), eq('registry', registry), eq('entriesHash', entriesHash))
      .createdBy(address)
      .limit(1)
      .fetch();
    const existing = entities[0];
    if (existing) return { written: false, entityKey: existing.$key };

    const { entityKey, txHash } = await wallet.createEntity(
      releaseLogSchema,
      { examId, registry, chainId: u64(BigInt(input.chainId)), entriesHash, released, body: input.body },
      createOptions(),
    );
    return { written: true, entityKey, txHash };
  }

  /** Writes the token unless this writer already has a row for its instance key in this exam. */
  async function mirrorReleaseToken(
    input: MirrorInput & { instancePublicKey: Hex },
  ): Promise<MirrorResult> {
    checkBody(input.body);
    checkToken(input.body);
    const examId = examIdColumn(input.examId);
    const registry = addr(getAddress(input.registry));
    const keyHash = instanceKeyHash(input.instancePublicKey);

    const { entities } = await client
      .select({ $key: true })
      .from(releaseTokenSchema)
      .where(eq('examId', examId), eq('registry', registry), eq('instanceKeyHash', keyHash))
      .createdBy(address)
      .limit(1)
      .fetch();
    const existing = entities[0];
    if (existing) return { written: false, entityKey: existing.$key };

    const { entityKey, txHash } = await wallet.createEntity(
      releaseTokenSchema,
      {
        examId,
        registry,
        chainId: u64(BigInt(input.chainId)),
        instanceKeyHash: keyHash,
        body: input.body,
      },
      createOptions(),
    );
    return { written: true, entityKey, txHash };
  }

  /**
   * Writes a heartbeat, every time: it says the writer is still running, so it is never deduped.
   * Readonly, not extendable, and gone after `heartbeatLifetimeHours`, so heartbeats clean themselves up.
   */
  async function heartbeat(input: HeartbeatInput): Promise<{ entityKey: Hex; txHash: Hash }> {
    const examId = examIdColumn(input.examId);
    const registry = addr(getAddress(input.registry));
    let entriesHash = '';
    if (input.entriesHash !== null) {
      if (!hash32.test(input.entriesHash)) throw new MirrorInputError('entriesHash is not 32 bytes of hex');
      entriesHash = input.entriesHash.toLowerCase();
    }
    const { entityKey, txHash } = await wallet.createEntity(
      relayHeartbeatSchema,
      { examId, registry, entriesHash, stage: input.stage ?? '' },
      {
        expiration: ExpirationTime.fromHours(arkiv.heartbeatLifetimeHours),
        flags: { readonly: true, permissionlessExtension: false },
      },
    );
    return { entityKey, txHash };
  }

  /**
   * Writes this writer's row for the exam, or patches it with the columns that changed. The stage
   * never moves back: given an earlier stage than the row has, the row keeps its stage and the
   * hashes of the later events, and only the other columns can change.
   */
  async function upsertExam(input: ExamIndexInput): Promise<UpsertExamResult> {
    const examId = examIdColumn(input.examId);
    const registry = getAddress(input.registry);
    const next = examColumns(input);

    // Two runs at once may both create a row; the lowest key is the one this writer keeps patching.
    const { entities } = await client
      .select({
        $key: true,
        board: true,
        chainId: true,
        stage: true,
        examStart: true,
        createdBlock: true,
        criteriaHash: true,
        approvedListHash: true,
        paperHash: true,
        name: true,
      })
      .from(examSchema)
      .where(eq('examId', examId), eq('registry', addr(registry)))
      .createdBy(address)
      .orderBy(asc('$key'))
      .limit(1)
      .fetch();
    const row = entities[0];

    if (!row) {
      const { entityKey, txHash } = await wallet.createEntity(
        examSchema,
        {
          examId,
          registry: addr(registry),
          board: addr(next.board),
          chainId: u64(next.chainId),
          stage: next.stage,
          examStart: u64(next.examStart),
          createdBlock: u64(next.createdBlock),
          criteriaHash: next.criteriaHash,
          approvedListHash: next.approvedListHash,
          paperHash: next.paperHash,
          name: next.name,
        },
        // Not readonly, so this writer can patch it as the exam moves on.
        { expiration: ExpirationTime.fromDays(arkiv.lifetimeDays), flags: { readonly: false, permissionlessExtension: true } },
      );
      return { action: 'created', entityKey, txHash };
    }

    // A stage the row doesn't know ranks lowest, so a valid one replaces it.
    const rowRank = examStages.indexOf(row.stage.value as ExamStage);
    const rank = examStages.indexOf(next.stage);
    if (rowRank > rank) {
      next.stage = row.stage.value as ExamStage;
      next.approvedListHash = row.approvedListHash.value;
      if (rowRank >= 2) next.paperHash = row.paperHash.value;
    }

    const set: Record<string, unknown> = {};
    if (!isAddressEqual(row.board.value, next.board)) set.board = addr(next.board);
    if (row.chainId.value !== next.chainId) set.chainId = u64(next.chainId);
    if (row.examStart.value !== next.examStart) set.examStart = u64(next.examStart);
    if (row.createdBlock.value !== next.createdBlock) set.createdBlock = u64(next.createdBlock);
    for (const column of ['stage', 'criteriaHash', 'approvedListHash', 'paperHash', 'name'] as const) {
      if (row[column].value !== next[column]) set[column] = next[column];
    }
    if (Object.keys(set).length === 0) return { action: 'unchanged', entityKey: row.$key };
    if (!wallet.patchEntity) throw new Error('the given walletClient has no patchEntity, so the exam row cannot change');
    const { txHash } = await wallet.patchEntity(examSchema, row.$key, { set });
    return { action: 'patched', entityKey: row.$key, txHash };
  }

  /**
   * Writes one readonly row per approved-list entry this writer has no row for in this exam,
   * keyed by `passkeyKeyHash`. Checks every entry first and writes nothing if any fails, so a
   * list is mirrored whole or not at all, though a failed transaction can leave it part written;
   * running again fills the rest.
   */
  async function mirrorParticipants(input: MirrorParticipantsInput): Promise<MirrorParticipantsResult> {
    const examId = examIdColumn(input.examId);
    const registry = getAddress(input.registry);
    const seen = new Set<string>();
    const rows = input.entries.map((entry, index) => {
      const at = `entry ${String(index)}`;
      const role = participantRoles[entry.role];
      if (role === undefined) throw new MirrorInputError(`${at} has unknown role ${String(entry.role)}`);
      if (entry.passkeyPublicKey.length === 0) throw new MirrorInputError(`${at} has no passkeyPublicKey`);
      if ((entry.derivedPublicKey.length === 0) !== (role === 'setter')) {
        throw new MirrorInputError(`${at} ${role === 'setter' ? 'is a setter with' : 'has no'} derivedPublicKey`);
      }
      if (entry.owner === '') throw new MirrorInputError(`${at} has an empty owner`);
      const passkeyKeyHash = keyHash(entry.passkeyPublicKey);
      if (seen.has(passkeyKeyHash)) throw new MirrorInputError(`${at} repeats a passkey`);
      seen.add(passkeyKeyHash);
      return {
        examId,
        registry: addr(registry),
        role,
        owner: checkStr(entry.owner, `${at} owner`),
        passkeyKeyHash,
        derivedKeyHash: keyHash(entry.derivedPublicKey),
      };
    });
    const result: MirrorParticipantsResult = { written: [], skipped: [], txHashes: [] };
    if (rows.length === 0) return result;

    const existing = new Map<string, Hex>();
    const found = await allPages((offset) =>
      client
        .select({ $key: true, passkeyKeyHash: true })
        .from(participantSchema)
        .where(eq('examId', examId), eq('registry', addr(registry)))
        .createdBy(address)
        .orderBy(asc('$key'))
        .limit(MAX_LIMIT)
        .offset(offset)
        .fetch(),
    );
    for (const row of found) if (!existing.has(row.passkeyKeyHash.value)) existing.set(row.passkeyKeyHash.value, row.$key);

    const missing = rows.filter((row) => {
      const key = existing.get(row.passkeyKeyHash);
      if (key !== undefined) result.skipped.push({ passkeyKeyHash: row.passkeyKeyHash, entityKey: key });
      return key === undefined;
    });
    const createOptions = () => ({
      expiration: ExpirationTime.fromDays(arkiv.lifetimeDays),
      flags: { readonly: true, permissionlessExtension: true },
    });

    if (wallet.executeBatch && missing.length > 1) {
      for (let start = 0; start < missing.length; start += participantBatchSize) {
        const batch = missing.slice(start, start + participantBatchSize);
        const { txHash, createdEntities } = await wallet.executeBatch({
          creates: batch.map((values) => ({ schema: participantSchema, values, ...createOptions() })),
        });
        if (createdEntities.length !== batch.length) {
          throw new Error(`a batch of ${String(batch.length)} creates returned ${String(createdEntities.length)} keys`);
        }
        result.txHashes.push(txHash);
        batch.forEach((row, index) => {
          result.written.push({ passkeyKeyHash: row.passkeyKeyHash, entityKey: createdEntities[index] as Hex });
        });
      }
    } else {
      for (const values of missing) {
        const { entityKey, txHash } = await wallet.createEntity(participantSchema, values, createOptions());
        result.txHashes.push(txHash);
        result.written.push({ passkeyKeyHash: values.passkeyKeyHash, entityKey });
      }
    }
    return result;
  }

  return { address, mirrorReleaseLog, mirrorReleaseToken, heartbeat, upsertExam, mirrorParticipants };
}

export type ArkivWriter = ReturnType<typeof createArkivWriter>;
