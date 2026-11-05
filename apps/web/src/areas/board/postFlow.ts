import { examRegistryAbi, OnChainBytesError, type ExamRegistry } from '@paperseal/chain';
import { approvedListHash, chain, fromHex, toHex, type Hex } from '@paperseal/protocol';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Address } from 'viem';

import { currentAccount, walletChainId, walletClientFor } from '../../shared/wallet';
import { PublishBlockedError, type PublishEnvironment } from './publishFlow';

/*
 * Posting the approved list and the Build from the board's wallet. As in publishFlow, every check
 * runs before anything is sent, a dry run explains a revert in words before the wallet is asked
 * for a signature, and the result is read back from ExamRegistry instead of assumed.
 */

export type PostStage = 'checking' | 'simulating' | 'wallet' | 'mining' | 'reading';

export const postStageLabels: Record<PostStage, string> = {
  checking: 'Checking the wallet, chain and board address.',
  simulating: 'Dry-running the call.',
  wallet: 'Waiting for you to confirm in your wallet.',
  mining: 'Waiting for the transaction to be mined.',
  reading: 'Reading the result back from ExamRegistry.',
};

export interface PostOutcome {
  transactionHash: Hex;
  blockNumber: bigint;
  /** Every value read back matches what was sent. */
  matches: boolean;
  rows: { label: string; expected: string; actual: string; match: boolean }[];
}

type FunctionName = 'postApprovedList' | 'postBuild';

/** Checks that must pass before anything is sent, then the dry run, the send and the mining. */
async function sendFromBoard(
  environment: PublishEnvironment,
  call: { functionName: FunctionName; args: readonly unknown[]; send: (registry: ExamRegistry) => Promise<Hex> },
  onStage: (stage: PostStage) => void,
): Promise<{ transactionHash: Hex; blockNumber: bigint; reader: ExamRegistry }> {
  const { registryAddress, publicClient, createRegistry } = environment;
  onStage('checking');
  const provider = environment.getProvider();
  if (!provider) throw new PublishBlockedError('No browser wallet was found. Install one in this Chromium browser and reload.');
  if (!registryAddress || !publicClient || !createRegistry) {
    throw new PublishBlockedError('Set VITE_RPC_URL and VITE_REGISTRY_ADDRESS to post.');
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
    throw new PublishBlockedError(`VITE_RPC_URL points to chain ${String(rpcChain)}, not Sepolia (chain ${String(chain.chainId)}).`);
  }
  const reader = createRegistry();
  const board = await reader.board();
  if (board.toLowerCase() !== account.toLowerCase()) {
    throw new PublishBlockedError(
      `The connected account ${account} is not the board address. ExamRegistry only accepts writes from ${board}. Switch accounts in your wallet.`,
    );
  }

  onStage('simulating');
  try {
    await publicClient.simulateContract({
      address: registryAddress as Address,
      abi: examRegistryAbi,
      functionName: call.functionName,
      args: call.args,
      account,
    } as Parameters<typeof publicClient.simulateContract>[0]);
  } catch (error) {
    throw new PublishBlockedError(explainPostError(error));
  }

  onStage('wallet');
  let transactionHash: Hex;
  try {
    transactionHash = await call.send(createRegistry(walletClientFor(provider, account)));
  } catch (error) {
    throw new PublishBlockedError(explainPostError(error));
  }

  onStage('mining');
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== 'success') {
    throw new Error(`The transaction ${transactionHash} was mined but reverted, so nothing was posted.`);
  }
  return { transactionHash, blockNumber: receipt.blockNumber, reader };
}

const lower = (hex: string) => hex.toLowerCase();
const row = (label: string, expected: string, actual: string) => ({
  label,
  expected,
  actual,
  match: expected === actual,
});

/**
 * Reads until a value comes back. An RPC node can lag the node that mined the block, so a posted
 * record whose event isn't visible yet (`missing`) counts as not there yet. Bytes that come back
 * but don't match the on-chain hash (`mismatch`) are an answer, and are returned as one.
 */
async function retry<T>(
  read: () => Promise<T | null>,
  attempts: number,
  wait: (ms: number) => Promise<void>,
): Promise<{ value: T } | { value: null; mismatch: OnChainBytesError } | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await read();
      if (value) return { value };
    } catch (error) {
      if (!(error instanceof OnChainBytesError)) throw error;
      if (error.kind === 'mismatch') return { value: null, mismatch: error };
    }
    await wait(1000);
  }
  return null;
}

export interface PostOptions {
  readBackAttempts?: number;
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `postApprovedList(examId, entries)`, then reads back the list hash and the emitted bytes. */
export async function postApprovedListFlow(
  environment: PublishEnvironment,
  input: { examId: Hex; entries: Hex },
  onStage: (stage: PostStage) => void = () => undefined,
  options: PostOptions = {},
): Promise<PostOutcome> {
  const { examId, entries } = input;
  const existing = environment.createRegistry ? await environment.createRegistry().getApprovedList(examId) : null;
  if (existing) {
    throw new PublishBlockedError('An approved list is already posted for this exam. It is write-once and cannot be replaced.');
  }
  const sent = await sendFromBoard(
    environment,
    { functionName: 'postApprovedList', args: [examId, entries], send: (registry) => registry.postApprovedList(examId, entries) },
    onStage,
  );
  onStage('reading');
  const wait = options.wait ?? sleep;
  const attempts = options.readBackAttempts ?? 5;
  const listRead = await retry(() => sent.reader.getApprovedList(examId), attempts, wait);
  const emittedRead = await retry(() => sent.reader.getApprovedListEntries(examId), attempts, wait);
  const list = listRead?.value;
  if (!list || !emittedRead) {
    throw new Error('The transaction was mined, but ExamRegistry does not return the list yet. Reload and check the approved list screen.');
  }
  const rows = [
    row('List hash', lower(toHex(approvedListHash(fromHex(examId), fromHex(entries)))), lower(list.listHash)),
    // Bytes the client refused (they don't hash to the stored list hash) are shown as a mismatch.
    row('Posted bytes', lower(entries), emittedRead.value ? lower(emittedRead.value) : 'bytes that do not hash to the list hash'),
  ];
  return { ...sent, rows, matches: rows.every((r) => r.match) };
}

/** The fields of a verified outbox Build, in the order `postBuild` takes them. */
export interface BuildPost {
  examId: Hex;
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

/** `postBuild(...)`, then reads the Build back and compares every field. */
export async function postBuildFlow(
  environment: PublishEnvironment,
  build: BuildPost,
  onStage: (stage: PostStage) => void = () => undefined,
  options: PostOptions = {},
): Promise<PostOutcome> {
  const args = [
    build.examId,
    build.approvedListHash,
    build.paperHash,
    build.storageManifestHash,
    build.saltedPaperHash,
    build.selected,
    build.bankSize,
    build.criteriaHash,
    build.teeSignature,
    build.instancePublicKey,
  ] as const;
  const existing = environment.createRegistry ? await environment.createRegistry().getBuild(build.examId) : null;
  if (existing) throw new PublishBlockedError('A Build is already posted for this exam. ExamRegistry accepts only one.');
  const sent = await sendFromBoard(
    environment,
    { functionName: 'postBuild', args, send: (registry) => registry.postBuild(...args) },
    onStage,
  );
  onStage('reading');
  const storedRead = await retry(() => sent.reader.getBuild(build.examId), options.readBackAttempts ?? 5, options.wait ?? sleep);
  const stored = storedRead?.value;
  if (!stored) {
    throw new Error('The transaction was mined, but ExamRegistry does not return the Build yet. Reload and check the overview.');
  }
  const rows = [
    row('Approved list hash', lower(build.approvedListHash), lower(stored.approvedListHash)),
    row('Paper hash', lower(build.paperHash), lower(stored.paperHash)),
    row('Storage manifest hash', lower(build.storageManifestHash), lower(stored.storageManifestHash)),
    row('Salted paper hash', lower(build.saltedPaperHash), lower(stored.saltedPaperHash)),
    row('Selected', String(build.selected), String(stored.selected)),
    row('Bank size', String(build.bankSize), String(stored.bankSize)),
    row('Criteria hash', lower(build.criteriaHash), lower(stored.criteriaHash)),
    row('TEE signature', lower(build.teeSignature), lower(stored.teeSignature)),
    row('Instance public key', lower(build.instancePublicKey), lower(stored.instancePublicKey)),
  ];
  return { ...sent, rows, matches: rows.every((r) => r.match) };
}

const revertMessages: Record<string, (args: readonly unknown[]) => string> = {
  NotBoard: ([caller]) => `Only the board address can post. ${String(caller)} is not it.`,
  ExamNotFound: () => 'This exam is not published on ExamRegistry yet. Publish it first.',
  ApprovedListAlreadyPosted: () => 'An approved list is already posted for this exam. It is write-once.',
  ApprovedListNotPosted: () => 'The approved list has not been posted yet, and a Build needs it.',
  ApprovedListHashMismatch: () =>
    'The Build was made against a different approved list than the one posted on-chain, so ExamRegistry refused it.',
  CriteriaHashMismatch: () => 'The Build carries different selection criteria from the ones this exam was published with.',
  BuildAlreadyPosted: () => 'A Build is already posted for this exam. ExamRegistry accepts only one.',
  ZeroValue: () => 'A required value is zero or empty.',
  InvalidSelection: () => 'The selected count must be at least 1 and no more than the bank size.',
  InvalidPublicKey: () => 'The TEE instance public key is not a 65-byte uncompressed P-256 point.',
  InvalidSignatureLength: () => 'The TEE signature is not 64 bytes.',
};

/** Turns a viem or wallet error from a post into a sentence for the board. */
export function explainPostError(error: unknown): string {
  if (error instanceof PublishBlockedError) return error.message;
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) {
        const explain = revertMessages[name];
        return explain ? explain(reverted.data?.args ?? []) : `ExamRegistry rejected the post: ${name}.`;
      }
      return `ExamRegistry rejected the post${reverted.reason ? `: ${reverted.reason}` : ' without a reason'}.`;
    }
    if (error.walk((cause) => cause instanceof UserRejectedRequestError)) {
      return 'You rejected the request in your wallet. Nothing was sent.';
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
