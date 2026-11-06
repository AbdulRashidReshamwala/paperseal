import { approvedListHash, chain as specChain, criteriaHash, fromHex, toHex, type Hex } from '@paperseal/protocol';
import {
  createPublicClient,
  getAbiItem,
  http,
  type Address,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';

import { examRegistryAbi } from './abi';

if (sepolia.id !== specChain.chainId) {
  throw new Error('spec/constants.json chain does not match viem sepolia');
}

const abi = examRegistryAbi;
const approvedListPosted = getAbiItem({ abi, name: 'ApprovedListPosted' });
const examCreated = getAbiItem({ abi, name: 'ExamCreated' });
const buildPosted = getAbiItem({ abi, name: 'BuildPosted' });
type ExamId = Hex;

/**
 * The widest `eth_getLogs` range `scanEvents` asks for by default, in blocks. Mirrors
 * `logChunkBlocks` in spec/arkiv.json, which this package doesn't import; callers that read the
 * spec pass it as `chunk`.
 */
export const defaultLogChunkBlocks = 10_000;
type Calldata = Hex;

/** The `ExamSettings` struct of `createExam`. `registry` and `chainId` are attested but not stored. */
export interface ExamSettingsArgs {
  examId: Hex;
  examStart: bigint;
  delta: bigint;
  lockRound: bigint;
  unlockRound: bigint;
  endRound: bigint;
  criteriaHash: Hex;
  rpcHost: string;
}

export interface ExamRegistryOptions {
  address: Address;
  /** RPC endpoint for Sepolia. Ignored when `transport` is given. */
  rpcUrl?: string;
  transport?: Transport;
  /** `false` stops reads from following an `OffchainLookup` revert to a gateway, as ENS reads require. */
  ccipRead?: false;
  /** Only the board's wallet can write. Reads work without one. */
  wallet?: WalletClient;
}

export class NoWalletError extends Error {
  constructor() {
    super('ExamRegistry writes need the board wallet');
    this.name = 'NoWalletError';
  }
}

/**
 * A record exists on chain but its bytes can't be trusted or found. `missing`: the RPC returned no
 * event for the record's block. `mismatch`: the event's bytes don't hash to the stored hash.
 * Callers must not fall back to the raw event.
 */
export class OnChainBytesError extends Error {
  readonly what: 'approvedList' | 'criteria';
  readonly kind: 'missing' | 'mismatch';

  constructor(what: 'approvedList' | 'criteria', kind: 'missing' | 'mismatch', message: string) {
    super(message);
    this.name = 'OnChainBytesError';
    this.what = what;
    this.kind = kind;
  }
}

/** Where an event was seen. */
export interface EventPosition {
  block: bigint;
  txHash: Hex;
}

/** `ExamCreated`, decoded. `criteria` hashes to `criteriaHash`. */
export interface ScannedExamCreated extends EventPosition {
  commitHash: Hex;
  imageDigest: Hex;
  examStart: bigint;
  delta: bigint;
  lockRound: bigint;
  unlockRound: bigint;
  endRound: bigint;
  criteriaHash: Hex;
  rpcHost: string;
  criteria: Hex;
}

/** `ApprovedListPosted`, decoded. `entries` hashes to `listHash`, and is not otherwise checked. */
export interface ScannedApprovedList extends EventPosition {
  listHash: Hex;
  entries: Hex;
}

/** `BuildPosted`, decoded. */
export interface ScannedBuild extends EventPosition {
  approvedListHash: Hex;
  paperHash: Hex;
  storageManifestHash: Hex;
  saltedPaperHash: Hex;
  selected: number;
  bankSize: number;
  criteriaHash: Hex;
  teeSignature: Hex;
  instancePublicKey: Hex;
}

/**
 * What the scanned range says about one exam. `created` is null when `ExamCreated` came before
 * `fromBlock` but a later event is in range; `getExam` has it.
 */
export interface ScannedExam {
  examId: Hex;
  created: ScannedExamCreated | null;
  list?: ScannedApprovedList;
  build?: ScannedBuild;
}

export interface ScanEventsOptions {
  fromBlock: bigint;
  /** Inclusive. Defaults to the latest block, read once before the scan. */
  toBlock?: bigint;
  /** The most blocks one `eth_getLogs` covers. Defaults to {@link defaultLogChunkBlocks}. */
  chunk?: number;
}

export interface ScanEventsResult {
  /** The range scanned, inclusive. `toBlock` is where the next scan starts after. */
  fromBlock: bigint;
  toBlock: bigint;
  /** In the order of each exam's first event in the range. */
  exams: ScannedExam[];
}

/** Throws unless `entries` hashes to `listHash`. Callers never fall back to the raw bytes. */
function checkListBytes(examId: ExamId, entries: Hex, listHash: Hex, source: string): void {
  if (toHex(approvedListHash(fromHex(examId), fromHex(entries))) !== listHash.toLowerCase()) {
    throw new OnChainBytesError('approvedList', 'mismatch', `The ApprovedListPosted bytes do not hash to ${source}.`);
  }
}

/** Throws unless `criteria` hashes to `expected`. */
function checkCriteriaBytes(criteria: Hex, expected: Hex, source: string): void {
  if (toHex(criteriaHash(fromHex(criteria))) !== expected.toLowerCase()) {
    throw new OnChainBytesError('criteria', 'mismatch', `The ExamCreated criteria do not hash to ${source}.`);
  }
}

/** A zero `createdAt` or `postedAt` means the record has not been written. */
const ifExists = <T>(record: T, stamp: bigint): T | null => (stamp === 0n ? null : record);

export function createExamRegistry(options: ExamRegistryOptions) {
  const { address, wallet } = options;
  const client: PublicClient = createPublicClient({
    chain: sepolia,
    transport: options.transport ?? http(options.rpcUrl),
    ...(options.ccipRead === false ? { ccipRead: false as const } : {}),
  });

  function requireWallet(): WalletClient & {
    account: NonNullable<WalletClient['account']>;
  } {
    if (!wallet?.account) throw new NoWalletError();
    return wallet as WalletClient & {
      account: NonNullable<WalletClient['account']>;
    };
  }

  function write(
    functionName: 'createExam' | 'postApprovedList' | 'postBuild',
    args: readonly unknown[],
  ): Promise<Hex> {
    const signer = requireWallet();
    return signer.writeContract({
      address,
      abi,
      functionName,
      args,
      account: signer.account,
      chain: sepolia,
    } as Parameters<WalletClient['writeContract']>[0]);
  }

  /**
   * Every `ExamCreated`, `ApprovedListPosted` and `BuildPosted` of this registry in
   * `[fromBlock, toBlock]`, grouped by exam. Asks for at most `chunk` blocks per `eth_getLogs`,
   * one range after another, because public RPCs refuse wider queries (spec/arkiv.md, "Exam
   * Index"). Each event's bytes are checked against the hash in the same event, so a decoded
   * `criteria` or `entries` is never one its own event disagrees with; readers still check
   * `getExam` and `getApprovedList`. The contract allows each event once per exam, so a repeat
   * is ignored.
   */
  async function scanEvents(scan: ScanEventsOptions): Promise<ScanEventsResult> {
    const chunk = scan.chunk ?? defaultLogChunkBlocks;
    if (!Number.isSafeInteger(chunk) || chunk < 1) throw new RangeError(`chunk must be a positive integer, got ${String(chunk)}`);
    const { fromBlock } = scan;
    if (fromBlock < 0n) throw new RangeError('fromBlock must not be negative');
    const toBlock = scan.toBlock ?? (await client.getBlockNumber());
    const exams = new Map<string, ScannedExam>();
    const examFor = (examId: Hex): ScannedExam => {
      const key = examId.toLowerCase();
      let exam = exams.get(key);
      if (!exam) {
        exam = { examId: key as Hex, created: null };
        exams.set(key, exam);
      }
      return exam;
    };

    for (let start = fromBlock; start <= toBlock; start += BigInt(chunk)) {
      const end = start + BigInt(chunk) - 1n < toBlock ? start + BigInt(chunk) - 1n : toBlock;
      const logs = await client.getLogs({
        address,
        events: [examCreated, approvedListPosted, buildPosted],
        fromBlock: start,
        toBlock: end,
        strict: true,
      });
      // Nodes return logs in order, but nothing requires it.
      const ordered = [...logs].sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
      );
      for (const log of ordered) {
        const position = { block: log.blockNumber, txHash: log.transactionHash };
        if (log.eventName === 'ExamCreated') {
          const { examId, ...args } = log.args;
          const exam = examFor(examId);
          if (exam.created) continue;
          checkCriteriaBytes(args.criteria, args.criteriaHash, 'the criteriaHash in its event');
          exam.created = { ...position, ...args };
        } else if (log.eventName === 'ApprovedListPosted') {
          const { examId, listHash, entries } = log.args;
          const exam = examFor(examId);
          if (exam.list) continue;
          checkListBytes(examId, entries, listHash, 'the listHash in its event');
          exam.list = { ...position, listHash, entries };
        } else {
          const { examId, ...args } = log.args;
          const exam = examFor(examId);
          if (exam.build) continue;
          exam.build = { ...position, ...args };
        }
      }
    }
    return { fromBlock, toBlock, exams: [...exams.values()] };
  }

  return {
    address,
    board: () => client.readContract({ address, abi, functionName: 'board' }),
    /** The deployed code here, or undefined when there is none. For `checkRegistryCode`. */
    code: () => client.getCode({ address }),

    getExam: async (examId: ExamId) => {
      const exam = await client.readContract({
        address,
        abi,
        functionName: 'getExam',
        args: [examId],
      });
      return ifExists(exam, exam.createdAt);
    },
    getApprovedList: async (examId: ExamId) => {
      const list = await client.readContract({
        address,
        abi,
        functionName: 'getApprovedList',
        args: [examId],
      });
      return ifExists(list, list.postedAt);
    },
    getBuild: async (examId: ExamId) => {
      const build = await client.readContract({
        address,
        abi,
        functionName: 'getBuild',
        args: [examId],
      });
      return ifExists(build, build.postedAt);
    },
    /**
     * The full `abi.encode(Approved List)` bytes from the ApprovedListPosted event, or null before
     * it is posted. Reads the record first and queries only its `postedBlock`, because public RPCs
     * reject wide `eth_getLogs` ranges. The bytes are hashed here and must equal the record's
     * `listHash`, so no caller trusts a raw event. A record whose bytes are missing or differ throws
     * `OnChainBytesError`.
     */
    getApprovedListEntries: async (examId: ExamId): Promise<Hex | null> => {
      const list = await client.readContract({
        address,
        abi,
        functionName: 'getApprovedList',
        args: [examId],
      });
      if (list.postedAt === 0n) return null;
      const logs = await client.getLogs({
        address,
        event: approvedListPosted,
        args: { examId },
        fromBlock: list.postedBlock,
        toBlock: list.postedBlock,
      });
      // The contract allows one post per exam. A log a reorg removed is not on the chain any more.
      const entries = logs.find((log) => !log.removed)?.args.entries;
      if (entries === undefined) {
        throw new OnChainBytesError(
          'approvedList',
          'missing',
          `The approved list is on chain, but the RPC returned no ApprovedListPosted event in block ${list.postedBlock.toString()}.`,
        );
      }
      checkListBytes(examId, entries, list.listHash, 'the on-chain listHash');
      return entries;
    },
    /**
     * The full `abi.encode(Criteria)` bytes from ExamCreated, read from the record's `createdBlock`
     * only, and checked against `settings.criteriaHash` here. Null before the exam exists; a record
     * whose bytes are missing or differ throws `OnChainBytesError`.
     */
    getCriteria: async (examId: ExamId): Promise<Hex | null> => {
      const exam = await client.readContract({
        address,
        abi,
        functionName: 'getExam',
        args: [examId],
      });
      if (exam.createdAt === 0n) return null;
      const logs = await client.getLogs({
        address,
        event: examCreated,
        args: { examId },
        fromBlock: exam.createdBlock,
        toBlock: exam.createdBlock,
      });
      const criteria = logs.find((log) => !log.removed)?.args.criteria;
      if (criteria === undefined) {
        throw new OnChainBytesError(
          'criteria',
          'missing',
          `The exam is on chain, but the RPC returned no ExamCreated event in block ${exam.createdBlock.toString()}.`,
        );
      }
      checkCriteriaBytes(criteria, exam.settings.criteriaHash, 'the on-chain criteriaHash');
      return criteria;
    },
    scanEvents,
    quicknetGenesisTime: () =>
      client.readContract({
        address,
        abi,
        functionName: 'QUICKNET_GENESIS_TIME',
      }),
    quicknetPeriodSeconds: () =>
      client.readContract({
        address,
        abi,
        functionName: 'QUICKNET_PERIOD_SECONDS',
      }),

    createExam: (
      commitHash: Calldata,
      imageDigest: Calldata,
      settings: ExamSettingsArgs,
      criteria: Hex,
    ) => write('createExam', [commitHash, imageDigest, settings, criteria]),
    postApprovedList: (examId: ExamId, entries: Hex) =>
      write('postApprovedList', [examId, entries]),
    /** `fields` are the `build` message fields after `examId`, in hash order. */
    postBuild: (
      examId: ExamId,
      fields: BuildFieldsArgs,
      teeSignature: Hex,
      instancePublicKey: Hex,
    ) => write('postBuild', [examId, fields, teeSignature, instancePublicKey]),
  };
}

/** The contract's `BuildFields` struct: the TEE's `build` message after `examId`. `builtRound` is a drand round. */
export interface BuildFieldsArgs {
  approvedListHash: Hex;
  paperHash: Hex;
  storageManifestHash: Hex;
  saltedPaperHash: Hex;
  selected: number;
  bankSize: number;
  criteriaHash: Hex;
  builtRound: bigint;
}

export type ExamRegistry = ReturnType<typeof createExamRegistry>;
