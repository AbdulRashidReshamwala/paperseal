import { examRegistryAbi, OnChainBytesError, type ExamRegistry } from '@paperseal/chain';
import { approvedListHash, chain, entriesOverLimit, fromHex, limits, toHex, type Hex } from '@paperseal/protocol';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Address } from 'viem';

import { currentAccount, switchToSepolia, walletChainId, walletClientFor } from '../../shared/wallet';
import { withDetails } from './details';
import { PublishBlockedError, type PublishEnvironment } from './publishFlow';

/*
 * Posting the approved list and the Build from the board's wallet. As in publishFlow, every check
 * runs before anything is sent, a dry run explains a revert in words before the wallet is asked
 * for a signature, and the result is read back from ExamRegistry instead of assumed.
 */

export type PostStage = 'checking' | 'simulating' | 'wallet' | 'mining' | 'reading';

export const postStageLabels: Record<PostStage, string> = {
  checking: 'Checking your wallet.',
  simulating: 'Checking your request.',
  wallet: 'Confirm in your wallet.',
  mining: 'Saving to the public record.',
  reading: 'Checking it saved correctly.',
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
  if (!provider) throw new PublishBlockedError('Your wallet was not found. Install a wallet extension in Chrome, then reload this page.');
  if (!registryAddress || !publicClient || !createRegistry) {
    throw new PublishBlockedError('Posting is not set up on this page. Ask whoever installed Paper Seal to finish the setup, then reload.');
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
    throw new Error(
      withDetails(
        'The public record refused it, so nothing was posted. Try again. If this happens again, contact whoever runs Paper Seal.',
        `Transaction ${transactionHash} was reverted.`,
      ),
    );
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
  // Checked before the wallet is asked: the network would drop a list this long and never say so.
  if (entriesOverLimit(fromHex(entries))) {
    throw new PublishBlockedError(
      withDetails(
        'The list is too long to post, and nothing was posted. Take some people off the list, or shorten their names, then try again.',
        `${String(fromHex(entries).length)} bytes. The limits are ${String(limits.entriesBytes)} bytes and ${String(limits.entries)} people.`,
      ),
    );
  }
  const existing = environment.createRegistry ? await environment.createRegistry().getApprovedList(examId) : null;
  if (existing) {
    throw new PublishBlockedError('The list of people is already posted for this exam. It cannot be replaced.');
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
    throw new Error('The list was sent, but it does not show yet. Wait a minute, then reload this page to see it.');
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
  if (existing) throw new PublishBlockedError('The sealed paper is already recorded for this exam. It cannot be recorded twice.');
  const sent = await sendFromBoard(
    environment,
    { functionName: 'postBuild', args, send: (registry) => registry.postBuild(...args) },
    onStage,
  );
  onStage('reading');
  const storedRead = await retry(() => sent.reader.getBuild(build.examId), options.readBackAttempts ?? 5, options.wait ?? sleep);
  const stored = storedRead?.value;
  if (!stored) {
    throw new Error('The record was sent, but it does not show yet. Wait a minute, then reload this page to see it.');
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
  NotBoard: () => 'Only the exam board’s account can post. Switch to that account in your wallet, then try again.',
  ExamNotFound: () => 'This exam is not published yet. Publish the exam first.',
  ApprovedListAlreadyPosted: () => 'The list of people is already posted for this exam. It cannot be replaced.',
  ApprovedListNotPosted: () => 'The list of people has not been posted yet. Post the list first.',
  ApprovedListHashMismatch: () =>
    'The sealed paper was made for a different list of people from the one posted, so it was refused. Contact whoever runs Paper Seal.',
  CriteriaHashMismatch: () => 'The sealed paper does not match the topics this exam was published with, so it was refused. Contact whoever runs Paper Seal.',
  BuildAlreadyPosted: () => 'The sealed paper is already recorded for this exam. It cannot be recorded twice.',
  ZeroValue: () => 'Something required is missing, so it was refused. Contact whoever runs Paper Seal.',
  InvalidSelection: () => 'The number of questions on the paper is not valid, so it was refused. Contact whoever runs Paper Seal.',
  InvalidPublicKey: () => 'The record is not in the right form, so it was refused. Contact whoever runs Paper Seal.',
  InvalidSignatureLength: () => 'The record is not in the right form, so it was refused. Contact whoever runs Paper Seal.',
};

const somethingWentWrong = 'Something went wrong, and nothing was posted. Try again. If it keeps happening, contact whoever runs Paper Seal.';

/** Turns a viem or wallet error from a post into a sentence for the board, with the original message folded behind it. */
export function explainPostError(error: unknown): string {
  if (error instanceof PublishBlockedError) return error.message;
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) {
        const explain = revertMessages[name];
        return explain ? explain(reverted.data?.args ?? []) : withDetails('The public record did not accept this. Nothing was posted. Try again.', name);
      }
      return withDetails('The public record did not accept this. Nothing was posted. Try again.', reverted.reason ?? '');
    }
    if (error.walk((cause) => cause instanceof UserRejectedRequestError)) {
      return 'You declined in your wallet, so nothing was posted. Press the button to try again.';
    }
    return withDetails(somethingWentWrong, error.shortMessage);
  }
  return withDetails(somethingWentWrong, error instanceof Error ? error.message : String(error));
}
