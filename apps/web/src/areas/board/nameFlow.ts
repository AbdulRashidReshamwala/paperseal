import { encodeExamNameRecords, examNameHolds, resolveExamName, type ExamNameRecords } from '@paperseal/chain';
import { BaseError, UserRejectedRequestError, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import type { Hex } from '@paperseal/protocol';

import { walletClientFor } from '../../shared/wallet';
import { splitDetails, withDetails } from './details';
import type { WalletStage } from './hooks';
import { boardWallet } from './postFlow';
import { PublishBlockedError, type PublishEnvironment } from './publishFlow';

/*
 * An exam's ENS name, written from the board's wallet right after it is published ("Exam Names" in
 * spec/api.md). The exam needs no name, so nothing here can touch the exam or stop the board: every
 * outcome is a state for the page to show. The name is shown only when `resolveExamName`, the check the
 * verifier runs, passes in full and the name holds what this app would write.
 */

export type ExamName =
  /** Nothing can be read here, so there is nothing to say. */
  | { state: 'off' }
  /** Every check passed. The only state that shows the name as set. */
  | { state: 'set'; name: string }
  /** Not set, and nothing is wrong: the board can set it. */
  | { state: 'unset'; name: string }
  | { state: 'no-primary-name'; message: string }
  /** Nothing went out, or it went out and was refused. Trying again sends it again. */
  | { state: 'failed'; message: string }
  /** It was saved, but the checks don't pass yet. Trying again reads again before anything is sent. */
  | { state: 'unconfirmed'; name: string; message: string };

export interface NameOptions {
  readBackAttempts?: number;
  wait?: (ms: number) => Promise<void>;
}

const exam = 'The exam is published and carries on without it.';
const noPrimaryName = `The exam name is not set, because the board’s wallet has no primary name. ${exam} Set a primary name, then press Try again.`;
const couldNotRead = `The exam name could not be checked right now. ${exam} Press Try again.`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The registry and the values this app writes to an exam's name. */
const recordsOf = (environment: PublishEnvironment, registry: Hex): ExamNameRecords => ({
  registry: registry as Address,
  ...environment.examNameValues,
});

/** The wallet's words for why nothing was saved, with the original message folded behind them. */
function explainNameError(error: unknown): string {
  if (error instanceof PublishBlockedError) return `${splitDetails(error.message).say} ${exam}`;
  if (error instanceof BaseError && error.walk((cause) => cause instanceof UserRejectedRequestError)) {
    return `You declined in your wallet, so the exam name is not set. ${exam} Press Try again to set it.`;
  }
  const detail = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
  return withDetails(`The exam name could not be set. ${exam} Press Try again.`, detail);
}

/** Reads what the name holds now. Sends nothing and never prompts, so it is safe on every visit. */
export async function readExamName(environment: PublishEnvironment, label: string): Promise<ExamName> {
  const { ensLookup: lookup, createRegistry, registryAddress } = environment;
  if (!lookup || !createRegistry || !registryAddress) return { state: 'off' };
  try {
    const primary = await lookup.primaryName(await createRegistry().board());
    if (!primary) return { state: 'no-primary-name', message: noPrimaryName };
    const name = `${label}.${primary}`;
    const resolved = await resolveExamName(name, { lookup });
    if (resolved.ok) {
      return examNameHolds(resolved.value, recordsOf(environment, registryAddress)) ? { state: 'set', name } : { state: 'unset', name };
    }
    if (resolved.failed === 'unreadable') return { state: 'failed', message: withDetails(couldNotRead, resolved.reason) };
    return { state: 'unset', name };
  } catch (error) {
    return { state: 'failed', message: withDetails(couldNotRead, error instanceof Error ? error.message : String(error)) };
  }
}

/** What opening an exam by name found. `retry`: the RPC couldn't answer, so nothing was decided. */
export type ExamNameRoute = { ok: true; examId: Hex } | { ok: false; retry: boolean; message: string };

/**
 * Whether a name in a link opens an exam on this app's registry. Every check in `resolveExamName` must
 * pass, so a name that fails opens nothing, and the exam is the name's own labelhash.
 */
export async function openExamName(environment: PublishEnvironment, name: string): Promise<ExamNameRoute> {
  const { ensLookup: lookup, registryAddress } = environment;
  if (!lookup || !registryAddress) return { ok: false, retry: false, message: 'This page cannot check exam names yet. Ask whoever installed Paper Seal to finish the setup.' };
  const resolved = await resolveExamName(name, { lookup });
  if (!resolved.ok) {
    return resolved.failed === 'unreadable'
      ? { ok: false, retry: true, message: withDetails('This exam name cannot be checked right now. Check your internet connection, then press Try again.', resolved.reason) }
      : { ok: false, retry: false, message: withDetails('This exam name did not pass its checks, so no exam was opened.', resolved.reason) };
  }
  if (resolved.value.registry.toLowerCase() !== registryAddress.toLowerCase()) {
    return { ok: false, retry: false, message: withDetails('This exam name belongs to a different public record, so no exam was opened.', `${name} names ${resolved.value.registry}.`) };
  }
  return { ok: true, examId: resolved.value.examId };
}

/** Reads until every check passes, because an RPC node can lag the node that mined the block. */
async function readUntilSet(environment: PublishEnvironment, name: string, registry: Hex, options: NameOptions): Promise<ExamName> {
  const attempts = options.readBackAttempts ?? 6;
  const wait = options.wait ?? sleep;
  let reason = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(2000);
    const resolved = await resolveExamName(name, environment.ensLookup ? { lookup: environment.ensLookup } : {});
    if (resolved.ok && examNameHolds(resolved.value, recordsOf(environment, registry))) return { state: 'set', name };
    reason = resolved.ok ? `${name} does not hold what was sent.` : resolved.reason;
  }
  return {
    state: 'unconfirmed',
    name,
    message: withDetails(`The exam name was sent, but it does not check out yet. ${exam} Wait a minute, then press Try again.`, reason),
  };
}

/**
 * Sends one transaction from the board's wallet that writes every record of the name, then reads it
 * back. A name already set sends nothing. The resolver is the one the chain gives for the board's
 * primary name, and a dry run explains a refusal before the wallet asks.
 */
export async function setExamName(
  environment: PublishEnvironment,
  label: string,
  onStage: (stage: WalletStage) => void = () => undefined,
  options: NameOptions = {},
): Promise<ExamName> {
  onStage('checking');
  try {
    const before = await readExamName(environment, label);
    if (before.state !== 'unset') return before;
    const { provider, account, publicClient, registryAddress } = await boardWallet(environment, `The exam name is not set up on this page. ${exam}`);
    const parent = before.name.slice(label.length + 1);
    const resolver = await environment.ensLookup?.resolver(parent);
    if (!resolver) return { state: 'failed', message: withDetails(`The exam name is not set, because the board’s name cannot hold it yet. ${exam}`, `${parent} has no resolver.`) };
    // The checks that writing can't fix. Stopping here saves the board a confirmation that would come to nothing.
    const forward = await environment.ensLookup?.address(parent);
    if (forward?.toLowerCase() !== account.toLowerCase()) {
      return { state: 'failed', message: withDetails(`The exam name is not set, because the board’s name does not point back to this wallet. ${exam}`, `${parent} points to ${forward ?? 'no address'}.`) };
    }
    const data = encodeExamNameRecords(before.name, recordsOf(environment, registryAddress));

    onStage('simulating');
    await publicClient.call({ account, to: resolver, data });

    onStage('wallet');
    const hash = await walletClientFor(provider, account).sendTransaction({ account, chain: sepolia, to: resolver, data });

    onStage('mining');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      return { state: 'failed', message: withDetails(`The public record refused the exam name, so it is not set. ${exam} Press Try again.`, `Transaction ${hash} was reverted.`) };
    }

    onStage('reading');
    return await readUntilSet(environment, before.name, registryAddress, options);
  } catch (error) {
    return { state: 'failed', message: explainNameError(error) };
  }
}
