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
type ExamId = Hex;
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

  return {
    address,
    board: () => client.readContract({ address, abi, functionName: 'board' }),

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
      // The contract allows one post per exam.
      const entries = logs[0]?.args.entries;
      if (entries === undefined) {
        throw new OnChainBytesError(
          'approvedList',
          'missing',
          `The approved list is on chain, but the RPC returned no ApprovedListPosted event in block ${list.postedBlock.toString()}.`,
        );
      }
      if (toHex(approvedListHash(fromHex(examId), fromHex(entries))) !== list.listHash.toLowerCase()) {
        throw new OnChainBytesError(
          'approvedList',
          'mismatch',
          'The ApprovedListPosted bytes do not hash to the on-chain listHash.',
        );
      }
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
      const criteria = logs[0]?.args.criteria;
      if (criteria === undefined) {
        throw new OnChainBytesError(
          'criteria',
          'missing',
          `The exam is on chain, but the RPC returned no ExamCreated event in block ${exam.createdBlock.toString()}.`,
        );
      }
      if (toHex(criteriaHash(fromHex(criteria))) !== exam.settings.criteriaHash.toLowerCase()) {
        throw new OnChainBytesError(
          'criteria',
          'mismatch',
          'The ExamCreated criteria do not hash to the on-chain criteriaHash.',
        );
      }
      return criteria;
    },
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
    postBuild: (
      examId: ExamId,
      approvedListHash: Hex,
      paperHash: Hex,
      storageManifestHash: Hex,
      saltedPaperHash: Hex,
      selected: number,
      bankSize: number,
      criteriaHash: Hex,
      teeSignature: Hex,
      instancePublicKey: Hex,
    ) =>
      write('postBuild', [
        examId,
        approvedListHash,
        paperHash,
        storageManifestHash,
        saltedPaperHash,
        selected,
        bankSize,
        criteriaHash,
        teeSignature,
        instancePublicKey,
      ]),
  };
}

export type ExamRegistry = ReturnType<typeof createExamRegistry>;
