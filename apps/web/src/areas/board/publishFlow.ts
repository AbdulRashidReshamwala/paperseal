import { createEnsLookup, createExamRegistry, examRegistryAbi, OnChainBytesError, type EnsLookup, type ExamRegistry } from '@paperseal/chain';
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

import { currentAccount, injectedProvider, switchToSepolia, walletChainId, walletClientFor, type EIP1193Provider } from '../../shared/wallet';
import { withDetails } from './details';
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
  /** Reads of ENS names, on chain only and over the same RPC. Null when it is not set, so names are left unread. */
  ensLookup?: EnsLookup | null;
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
    ensLookup: rpcUrl ? createEnsLookup({ rpcUrl }) : null,
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
  let criteriaMismatch = false;
  // An RPC node can briefly lag the node that mined the block.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    exam = await registry.getExam(request.examId);
    try {
      criteriaHex = exam ? await registry.getCriteria(request.examId) : null;
    } catch (error) {
      // `missing`: the event isn't visible yet. `mismatch`: the bytes don't hash to what was stored.
      if (!(error instanceof OnChainBytesError)) throw error;
      criteriaMismatch = error.kind === 'mismatch';
    }
    if (exam && (criteriaHex || criteriaMismatch)) break;
    await wait(1000);
  }
  if (!exam || (!criteriaHex && !criteriaMismatch)) {
    throw new Error('The exam was sent, but it does not show yet. Wait a minute, then reload this page to see it.');
  }
  const expected = settingsArgs(request);
  const { settings } = exam;
  const criteria = ((): Criteria | null => {
    if (!criteriaHex) return null;
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
    criteriaHex
      ? row('Criteria bytes', lower(request.criteria.encoded), lower(criteriaHex))
      : row('Criteria bytes', lower(request.criteria.encoded), 'bytes that do not hash to the criteria hash'),
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
  if (!provider) throw new PublishBlockedError('Your wallet was not found. Install a wallet extension in Chrome, then reload this page.');
  if (!registryAddress || !publicClient || !createRegistry) {
    throw new PublishBlockedError('Publishing is not set up on this page. Ask whoever installed Paper Seal to finish the setup, then reload.');
  }
  const account = await currentAccount(provider);
  if (!account) throw new PublishBlockedError('Connect your wallet, then press the button again.');

  // A wallet on the wrong network is asked to switch. If it declines or can't, the instruction below is shown.
  await switchToSepolia(provider);
  const [walletChain, rpcChain] = [await walletChainId(provider), await publicClient.getChainId()];
  if (walletChain !== chain.chainId) {
    throw new PublishBlockedError(
      'Your wallet is on the wrong network. Switch it to Sepolia in your wallet, then try again.',
    );
  }
  if (rpcChain !== chain.chainId) {
    throw new PublishBlockedError(
      withDetails(
        'This page is connected to the wrong network. Ask whoever installed Paper Seal to fix the setup, then reload.',
        `The page reads from chain ${String(rpcChain)}, not Sepolia (chain ${String(chain.chainId)}).`,
      ),
    );
  }

  const reader = createRegistry();
  const board = await reader.board();
  if (board.toLowerCase() !== account.toLowerCase()) {
    throw new PublishBlockedError(
      withDetails(
        'This wallet account is not the exam board’s account. Switch to the board’s account in your wallet, then try again.',
        `Connected: ${account}. Board: ${board}.`,
      ),
    );
  }
  if (await reader.getExam(request.examId)) {
    throw new PublishBlockedError('An exam with this name is already published. A published exam cannot be changed or replaced. Go back and use another name.');
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
    throw new Error(
      withDetails(
        'The public record refused the exam, so nothing was published. Try again. If this happens again, contact whoever runs Paper Seal.',
        `Transaction ${transactionHash} was reverted.`,
      ),
    );
  }

  onStage('reading');
  const back = await readBack(reader, request, options.readBackAttempts, options.wait);
  return { transactionHash, blockNumber: receipt.blockNumber, ...back };
}

const revertMessages: Record<string, (args: readonly unknown[]) => string> = {
  NotBoard: () => 'Only the exam board’s account can publish. Switch to that account in your wallet, then try again.',
  ZeroBoardAddress: () => 'Publishing is not set up correctly. Ask whoever installed Paper Seal to fix it.',
  ZeroValue: () => 'Something required is missing. Go back, check every detail, then try again.',
  InvalidRounds: () => 'The times do not fit together. Questions must close before the paper is released, and the paper before the exam ends. Go back and change the times.',
  InvalidExamStart: () => 'The exam date is too early. Go back and choose a later date.',
  InvalidEndRound: () => 'The exam must end after it starts. Go back and check the length.',
  ExamAlreadyExists: () => 'An exam with this name is already published. A published exam cannot be replaced. Go back and use another name.',
  UnlockRoundMismatch: () => 'The release time was not accepted. Go back, check the times, then try again.',
  CriteriaHashMismatch: () => 'The topics did not save correctly. Go back and try again.',
};

const somethingWentWrong =
  'Something went wrong, and nothing was published. Try again. If it keeps happening, contact whoever runs Paper Seal.';

/** Turns a viem or wallet error into a sentence for the board, with the original message folded behind it. */
export function explainError(error: unknown): string {
  if (error instanceof PublishBlockedError) return error.message;
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) {
        const explain = revertMessages[name];
        return explain ? explain(reverted.data?.args ?? []) : withDetails('The public record did not accept the exam. Go back, check the details, then try again.', name);
      }
      return withDetails('The public record did not accept the exam. Go back, check the details, then try again.', reverted.reason ?? '');
    }
    if (error.walk((cause) => cause instanceof UserRejectedRequestError)) {
      return 'You declined in your wallet, so nothing was published. Press the button to try again.';
    }
    return withDetails(somethingWentWrong, error.shortMessage);
  }
  return withDetails(somethingWentWrong, error instanceof Error ? error.message : String(error));
}
