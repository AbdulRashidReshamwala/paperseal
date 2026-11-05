import { chain as specChain, type Hex } from '@paperseal/protocol';
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
  /** Only the board's wallet can write. Reads work without one. */
  wallet?: WalletClient;
}

export class NoWalletError extends Error {
  constructor() {
    super('ExamRegistry writes need the board wallet');
    this.name = 'NoWalletError';
  }
}

/** A zero `createdAt` or `postedAt` means the record has not been written. */
const ifExists = <T>(record: T, stamp: bigint): T | null => (stamp === 0n ? null : record);

export function createExamRegistry(options: ExamRegistryOptions) {
  const { address, wallet } = options;
  const client: PublicClient = createPublicClient({
    chain: sepolia,
    transport: options.transport ?? http(options.rpcUrl),
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
     * reject wide `eth_getLogs` ranges.
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
      return logs[0]?.args.entries ?? null;
    },
    /** The full `abi.encode(Criteria)` bytes from ExamCreated, read from the record's `createdBlock` only. */
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
      return logs[0]?.args.criteria ?? null;
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
