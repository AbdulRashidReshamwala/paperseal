import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
  type WalletArkivClient,
} from '@arkiv-network/sdk';
import { eq } from '@arkiv-network/sdk/query';
import { addr, MAX_ENTITY_BYTES, u64 } from '@arkiv-network/sdk/schema';
import {
  getAddress,
  hexToBytes,
  isHex,
  sha256,
  type Account,
  type Address,
  type Hash,
  type Hex,
} from 'viem';

import { arkivChain, arkivTransport, examIdColumn, type ArkivConnection } from './client';
import { relayHeartbeatSchema, releaseLogSchema, releaseTokenSchema } from './schemas';
import { arkiv } from './spec';

export interface ArkivWriterOptions extends ArkivConnection {
  /** The writer, which the code calls the relay. Its address is what readers trust. */
  account: Account | Address;
  /**
   * A wallet client to create rows with, such as one built from a wagmi connection. Defaults to one
   * built from `account` and the connection.
   */
  walletClient?: Pick<WalletArkivClient, 'createEntity'> | undefined;
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

  return { address, mirrorReleaseLog, mirrorReleaseToken, heartbeat };
}

export type ArkivWriter = ReturnType<typeof createArkivWriter>;
