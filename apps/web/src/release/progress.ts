import type { ExamRegistry } from '@paperseal/chain';
import { roles, roundAtSeconds, type ApprovedListEntry, type Hex } from '@paperseal/protocol';
import type { StatusResponse } from '@paperseal/tee-client';
import { useEffect, useMemo, useState } from 'react';

import { storageUrl } from '../shared/config';
import { useCurrentExamId } from '../shared/currentExam';
import { listEntryFor, useHolderCredential, type HolderRole } from '../shared/holder';
import type { StoredCredential } from '../shared/Register';
import { registry } from '../shared/registry';
import { tee } from '../shared/tee';
import { usePoll, type Polled } from '../shared/usePoll';

/*
 * What the key holder and centre pages decide their screen from. Everything here only picks what
 * to show: the release and unlock flows make their own checks, whatever the screen says.
 */

/** How often the sealed machine's stage and release count are read again. */
export const STATUS_POLL_MS = 5000;
/** How often the public record is read while something is still to be posted. */
export const CHAIN_POLL_MS = 15000;

export interface ChainFacts {
  /** Null until the exam is published. */
  unlockRound: number | null;
  /** The drand round at the end of the exam. Null until the exam is published. */
  endRound: number | null;
  listPosted: boolean;
  /** This key's entry on the on-chain approved list, or null if it has none. */
  entry: ApprovedListEntry | null;
  buildPosted: boolean;
}

export interface HolderProgress {
  /** Build settings still missing, so this page cannot reach the exam. */
  missing: readonly string[];
  examId: Hex | null;
  credential: StoredCredential | null;
  chain: Pick<Polled<ChainFacts>, 'value' | 'error' | 'settled'>;
  status: Pick<Polled<StatusResponse>, 'value' | 'error' | 'settled'>;
  /** The public clock has reached the unlock round, by this computer's time. The sealed machine has the last word. */
  reached: boolean;
  /**
   * The exam is over: the sealed machine says it released or failed, or the end round has passed. Nobody
   * can usefully register by then, so registration is not offered.
   */
  ended: boolean;
}

export interface ProgressActions {
  refresh: () => void;
  registered: (credential: StoredCredential) => void;
}

/** The screens every holder shares until its own flow can start. */
export type GateStage = 'setup' | 'register' | 'ended' | 'loading' | 'unreachable' | 'no-exam' | 'awaiting-list' | 'not-on-list';

export const holderRoles: readonly number[] = [roles.neutral, roles.centreKeyHolder];
export const centreRoles: readonly number[] = [roles.centre, roles.centreKeyHolder];

/** The first shared screen that is not finished, or null once the page's own flow can start. */
export function holderGate(progress: HolderProgress, allowedRoles: readonly number[]): GateStage | null {
  const { chain } = progress;
  if (progress.missing.length > 0) return 'setup';
  if (!progress.credential) {
    if (progress.ended) return 'ended';
    // Registration is offered only once the exam is known not to be over, so it never flashes up and goes.
    if (chain.settled === false && !chain.value && !chain.error) return 'loading';
    return 'register';
  }
  if (!chain.value) return chain.error ? 'unreachable' : 'loading';
  if (chain.value.unlockRound === null) return 'no-exam';
  if (!chain.value.listPosted) return 'awaiting-list';
  if (!chain.value.entry || !allowedRoles.includes(chain.value.entry.role)) return 'not-on-list';
  return null;
}

/** Whether the sealed machine lists this key among the accepted releases. */
export function hasReleased(status: StatusResponse | null, credential: StoredCredential | null): boolean {
  if (!status || !credential) return false;
  return status.release.released.some((key) => key.toLowerCase() === credential.passkeyPublicKey.toLowerCase());
}

function missingSettings(examId: Hex | null): string[] {
  return [
    ...(registry ? [] : ['VITE_RPC_URL and VITE_REGISTRY_ADDRESS']),
    ...(examId ? [] : ['VITE_EXAM_ID']),
    ...(tee ? [] : ['VITE_TEE_URL']),
    ...(storageUrl ? [] : ['VITE_STORAGE_URL']),
  ];
}

async function readChainFacts(reader: ExamRegistry, exam: Hex, passkeyPublicKey: Hex | null): Promise<ChainFacts> {
  const [published, list, build] = await Promise.all([reader.getExam(exam), reader.getApprovedList(exam), reader.getBuild(exam)]);
  return {
    unlockRound: published ? Number(published.settings.unlockRound) : null,
    endRound: published ? Number(published.settings.endRound) : null,
    listPosted: list !== null,
    entry: list && passkeyPublicKey ? await listEntryFor(reader, exam, passkeyPublicKey) : null,
    buildPosted: build !== null,
  };
}

/** Each of these is written once, so there is nothing more to read after all three are posted. */
const chainFinished = (facts: ChainFacts) => facts.unlockRound !== null && facts.listPosted && facts.buildPosted;

const readStatus = () => {
  if (!tee) throw new Error('No sealed machine is configured.');
  return tee.status();
};

function useRoundReached(round: number | null): boolean {
  const [reached, setReached] = useState(false);
  useEffect(() => {
    if (round === null) return;
    const check = () => {
      setReached(roundAtSeconds(Math.floor(Date.now() / 1000)) >= round);
    };
    check();
    const id = setInterval(check, 1000);
    return () => {
      clearInterval(id);
    };
  }, [round]);
  return round !== null && reached;
}

/** Reads the exam for this browser's key, and keeps reading it, so the page moves on by itself. */
export function useHolderProgress(role: HolderRole): { progress: HolderProgress; actions: ProgressActions; settled: boolean } {
  const examId = useCurrentExamId();
  const stored = useHolderCredential(role);
  const [fresh, setFresh] = useState<StoredCredential | null>(null);
  const credential = fresh ?? stored;
  const passkey = credential?.passkeyPublicKey ?? null;

  const loadChain = useMemo(() => {
    const reader = registry;
    return reader && examId ? () => readChainFacts(reader, examId, passkey) : null;
  }, [examId, passkey]);
  const chain = usePoll(loadChain, CHAIN_POLL_MS, chainFinished);
  const status = usePoll(tee ? readStatus : null, STATUS_POLL_MS);
  const reached = useRoundReached(chain.value?.unlockRound ?? null);
  const endReached = useRoundReached(chain.value?.endRound ?? null);
  const ended = endReached || status.value?.stage === 'released' || status.value?.stage === 'failed';
  const missing = missingSettings(examId);

  const { refresh: refreshChain } = chain;
  const { refresh: refreshStatus } = status;
  const actions = useMemo<ProgressActions>(
    () => ({
      refresh: () => {
        refreshChain();
        refreshStatus();
      },
      registered: (next) => {
        setFresh(next);
      },
    }),
    [refreshChain, refreshStatus],
  );

  // Both first reads are back, so the page can pick its screen without changing it a moment later.
  const settled = missing.length > 0 || (chain.settled && status.settled);
  return { progress: { missing, examId, credential, chain, status, reached, ended }, actions, settled };
}
