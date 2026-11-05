import { createExamRegistry, examRegistryAbi, type ExamRegistry } from '@paperseal/chain';
import { chain, decodeCriteria, fromHex, type Criteria, type Hex } from '@paperseal/protocol';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  UserRejectedRequestError,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';

import { currentAccount, injectedProvider, walletChainId, walletClientFor, type EIP1193Provider } from '../../shared/wallet';
import type { PublishFields, ScheduleSettings } from './form';

/*
 * The Publish step. Every check runs before anything is sent, and the result is
 * read back from ExamRegistry rather than assumed. Nothing here fakes a
 * transaction: a missing wallet, wrong chain or wrong account stops the flow.
 */

export interface PublishEnvironment {
  registryAddress: Hex | null;
  getProvider: () => EIP1193Provider | null;
  /** Reads, simulation and receipts, over VITE_RPC_URL. Null when it is not set. */
  publicClient: PublicClient | null;
  /** A registry on `packages/chain`; with a wallet client it can write. */
  createRegistry: ((wallet?: WalletClient) => ExamRegistry) | null;
}

export function defaultEnvironment(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
): PublishEnvironment {
  const rpcUrl = env.VITE_RPC_URL;
  const address = env.VITE_REGISTRY_ADDRESS as Hex | undefined;
  return {
    registryAddress: address ?? null,
    getProvider: injectedProvider,
    publicClient: rpcUrl ? createPublicClient({ chain: sepolia, transport: http(rpcUrl) }) : null,
    createRegistry:
      rpcUrl && address ? (wallet) => createExamRegistry({ address, rpcUrl, ...(wallet ? { wallet } : {}) }) : null,
  };
}

/** Why publishing cannot proceed, in words for the board. Raised before anything is sent. */
export class PublishBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishBlockedError';
  }
}

export interface PublishRequest {
  examId: Hex;
  fields: PublishFields;
  schedule: ScheduleSettings;
  criteria: { encoded: Hex; hash: Hex };
}

export type PublishStage = 'checking' | 'simulating' | 'wallet' | 'mining' | 'reading';

export interface ReadBackRow {
  label: string;
  expected: string;
  actual: string;
  match: boolean;
}

export interface PublishOutcome {
  transactionHash: Hex;
  blockNumber: bigint;
  rows: ReadBackRow[];
  /** Every row matches. */
  matches: boolean;
  criteria: Criteria | null;
}

function settingsArgs(request: PublishRequest) {
  const { examId, fields, schedule } = request;
  return {
    examId,
    examStart: BigInt(schedule.examStart),
    delta: BigInt(schedule.delta),
    lockRound: BigInt(schedule.lockRound),
    unlockRound: BigInt(schedule.unlockRound),
    endRound: BigInt(schedule.endRound),
    criteriaHash: request.criteria.hash,
    rpcHost: fields.rpcHost,
  };
}

const lower = (hex: string) => hex.toLowerCase();

/** Reads `getExam` and `getCriteria` and lines each stored value up against what was entered. */
export async function readBack(
  registry: Pick<ExamRegistry, 'getExam' | 'getCriteria'>,
  request: PublishRequest,
  attempts = 5,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Pick<PublishOutcome, 'rows' | 'matches' | 'criteria'>> {
  let exam = null;
  let criteriaHex: Hex | null = null;
  // An RPC node can briefly lag the node that mined the block.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    exam = await registry.getExam(request.examId);
    criteriaHex = exam ? await registry.getCriteria(request.examId) : null;
    if (exam && criteriaHex) break;
    await wait(1000);
  }
  if (!exam || !criteriaHex) {
    throw new Error('The transaction was mined, but ExamRegistry does not return the exam yet. Reload and check the overview.');
  }
  const expected = settingsArgs(request);
  const { settings } = exam;
  const criteria = ((): Criteria | null => {
    try {
      return decodeCriteria(fromHex(criteriaHex));
    } catch {
      return null;
    }
  })();
  const row = (label: string, want: string, got: string, same = want === got): ReadBackRow => ({
    label,
    expected: want,
    actual: got,
    match: same,
  });
  const rows = [
    row('Exam ID', lower(request.examId), lower(settings.examId)),
    row('Commit hash', lower(request.fields.commitHash), lower(exam.commitHash)),
    row('Image digest', lower(request.fields.imageDigest), lower(exam.imageDigest)),
    row('Exam start, T', String(expected.examStart), String(settings.examStart)),
    row('Δ', String(expected.delta), String(settings.delta)),
    row('Lock round', String(expected.lockRound), String(settings.lockRound)),
    row('Unlock round', String(expected.unlockRound), String(settings.unlockRound)),
    row('End round', String(expected.endRound), String(settings.endRound)),
    row('RPC operator host', expected.rpcHost, settings.rpcHost),
    row('Criteria hash', lower(expected.criteriaHash), lower(settings.criteriaHash)),
    row('Criteria bytes', lower(request.criteria.encoded), lower(criteriaHex), lower(request.criteria.encoded) === lower(criteriaHex)),
  ];
  return { rows, matches: rows.every((r) => r.match) && criteria !== null, criteria };
}

export async function publishExam(
  environment: PublishEnvironment,
  request: PublishRequest,
  onStage: (stage: PublishStage) => void = () => undefined,
  options: { readBackAttempts?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<PublishOutcome> {
  const { registryAddress, publicClient, createRegistry } = environment;
  onStage('checking');
  const provider = environment.getProvider();
  if (!provider) throw new PublishBlockedError('No browser wallet was found. Install one in this Chromium browser and reload.');
  if (!registryAddress || !publicClient || !createRegistry) {
    throw new PublishBlockedError('Set VITE_RPC_URL and VITE_REGISTRY_ADDRESS to publish.');
  }
  const account = await currentAccount(provider);
  if (!account) throw new PublishBlockedError('Connect your wallet first.');

  const [walletChain, rpcChain] = [await walletChainId(provider), await publicClient.getChainId()];
  if (walletChain !== chain.chainId) {
    throw new PublishBlockedError(
      `Your wallet is on chain ${String(walletChain)}. Switch it to Sepolia (chain ${String(chain.chainId)}) and try again.`,
    );
  }
  if (rpcChain !== chain.chainId) {
    throw new PublishBlockedError(
      `VITE_RPC_URL points to chain ${String(rpcChain)}, not Sepolia (chain ${String(chain.chainId)}).`,
    );
  }

  const reader = createRegistry();
  const board = await reader.board();
  if (board.toLowerCase() !== account.toLowerCase()) {
    throw new PublishBlockedError(
      `The connected account ${account} is not the board address. ExamRegistry only accepts writes from ${board}. Switch accounts in your wallet.`,
    );
  }
  if (await reader.getExam(request.examId)) {
    throw new PublishBlockedError('An exam with this name is already published. Published exams cannot be replaced, so use another name.');
  }

  const settings = settingsArgs(request);
  const args = [request.fields.commitHash, request.fields.imageDigest, settings, request.criteria.encoded] as const;

  // A dry run first, so a revert is explained before the wallet asks for a signature.
  onStage('simulating');
  try {
    await publicClient.simulateContract({
      address: registryAddress as Address,
      abi: examRegistryAbi,
      functionName: 'createExam',
      args,
      account,
    });
  } catch (error) {
    throw new PublishBlockedError(explainError(error));
  }

  onStage('wallet');
  let transactionHash: Hex;
  try {
    transactionHash = await createRegistry(walletClientFor(provider, account)).createExam(...args);
  } catch (error) {
    throw new PublishBlockedError(explainError(error));
  }

  onStage('mining');
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== 'success') {
    throw new Error(`The transaction ${transactionHash} was mined but reverted, so nothing was published.`);
  }

  onStage('reading');
  const back = await readBack(reader, request, options.readBackAttempts, options.wait);
  return { transactionHash, blockNumber: receipt.blockNumber, ...back };
}

const revertMessages: Record<string, (args: readonly unknown[]) => string> = {
  NotBoard: ([caller]) => `Only the board address can publish. ${String(caller)} is not it.`,
  ZeroBoardAddress: () => 'The registry has no board address.',
  ZeroValue: () => 'A required value is zero or empty: the exam ID, commit hash, image digest, criteria hash, Δ, RPC host or criteria.',
  InvalidRounds: () => 'The rounds must satisfy lock < unlock < end, and the lock round cannot be zero.',
  InvalidExamStart: () => 'The exam start minus Δ must be after the drand quicknet genesis.',
  InvalidEndRound: () => 'The end round must be produced after the exam start.',
  ExamAlreadyExists: () => 'An exam with this ID is already published. Published exams cannot be replaced.',
  UnlockRoundMismatch: ([expected, actual]) =>
    `The unlock round must be ${String(expected)}, the first round at or after T − Δ, but ${String(actual)} was sent.`,
  CriteriaHashMismatch: () => 'The criteria bytes do not hash to the criteria hash.',
};

/** Turns a viem or wallet error into a sentence for the board. */
export function explainError(error: unknown): string {
  if (error instanceof PublishBlockedError) return error.message;
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) {
        const explain = revertMessages[name];
        return explain ? explain(reverted.data?.args ?? []) : `ExamRegistry rejected the exam: ${name}.`;
      }
      return `ExamRegistry rejected the exam${reverted.reason ? `: ${reverted.reason}` : ' without a reason'}.`;
    }
    if (error.walk((cause) => cause instanceof UserRejectedRequestError)) {
      return 'You rejected the request in your wallet. Nothing was sent.';
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
