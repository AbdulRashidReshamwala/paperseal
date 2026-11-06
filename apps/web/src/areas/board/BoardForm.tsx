import type { ExamRegistry } from '@paperseal/chain';
import type { TeeClient } from '@paperseal/tee-client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { tee as defaultTee } from '../../shared/tee';
import { clearDraft, loadDraft, saveDraft } from './draftStore';
import { emptyPublish, type PublishInput } from './form';
import { defaultPlan, defaultRpcHost, evaluatePlan, type DraftStep, type PlanInput } from './plan';
import type { PostOutcome } from './postFlow';
import { defaultEnvironment, type PublishEnvironment, type PublishOutcome } from './publishFlow';

/*
 * The form lives here, in the board route area, so moving between steps keeps what was typed. It is
 * also kept in this browser (`draftStore.ts`) until the exam is published, so a reload loses nothing.
 * Receipts are this session's read-backs of what was posted.
 */

export type Receipt =
  | { kind: 'publish'; outcome: PublishOutcome; version: string; name: string }
  | { kind: 'list' | 'build'; outcome: PostOutcome };

interface BoardForm {
  plan: PlanInput;
  setPlan: (next: PlanInput) => void;
  publish: PublishInput;
  setPublish: (next: PublishInput) => void;
  draftStep: DraftStep;
  setDraftStep: (next: DraftStep) => void;
  /** Forgets the draft, once it has become an exam. */
  resetDraft: () => void;
  /** The published exam's name. ExamRegistry stores only its hash, so this lasts for the session. */
  examName: string | null;
  receipts: readonly Receipt[];
  /** A receipt the board has to see before the flow moves on. */
  held: Receipt | null;
  addReceipt: (receipt: Receipt) => void;
  dismissHeld: () => void;
  environment: PublishEnvironment;
  tee: TeeClient | null;
}

const BoardFormContext = createContext<BoardForm | null>(null);

/** Only a write that did not read back correctly stops the flow. A correct one moves straight on. */
const mustBeSeen = (receipt: Receipt) => !receipt.outcome.matches;

export function BoardFormProvider(props: {
  environment?: PublishEnvironment | undefined;
  tee?: TeeClient | null | undefined;
  children: ReactNode;
}) {
  const [saved] = useState(loadDraft);
  const [plan, setPlan] = useState<PlanInput>(saved?.plan ?? defaultPlan);
  const [publish, setPublish] = useState<PublishInput>(() => ({
    ...emptyPublish,
    ...(saved?.publish ?? {}),
    rpcHost: saved?.publish.rpcHost || defaultRpcHost(),
  }));
  const [draftStep, setDraftStep] = useState<DraftStep>(saved?.draftStep ?? 'create');
  const [receipts, setReceipts] = useState<readonly Receipt[]>([]);
  const [held, setHeld] = useState<Receipt | null>(null);
  const [examName, setExamName] = useState<string | null>(null);
  const { environment: given, tee: givenTee } = props;
  const environment = useMemo(() => given ?? defaultEnvironment(), [given]);
  const tee = givenTee === undefined ? defaultTee : givenTee;

  // A draft that is back to its start is not kept, which is also how a published exam clears it.
  useEffect(() => {
    if (plan === defaultPlan && draftStep === 'create' && publish.version === '') clearDraft();
    else saveDraft({ plan, publish, draftStep });
  }, [plan, publish, draftStep]);

  const resetDraft = useCallback(() => {
    clearDraft();
    setPlan(defaultPlan);
    setPublish((previous) => ({ ...previous, version: '' }));
    setDraftStep('create');
  }, []);
  const addReceipt = useCallback((receipt: Receipt) => {
    setReceipts((previous) => [...previous, receipt]);
    if (mustBeSeen(receipt)) setHeld(receipt);
    if (receipt.kind === 'publish' && receipt.outcome.matches) setExamName(receipt.name);
  }, []);
  const dismissHeld = useCallback(() => {
    setHeld(null);
  }, []);

  const value = useMemo(
    () => ({
      plan,
      setPlan,
      publish,
      setPublish,
      draftStep,
      setDraftStep,
      resetDraft,
      examName,
      receipts,
      held,
      addReceipt,
      dismissHeld,
      environment,
      tee,
    }),
    [plan, publish, draftStep, resetDraft, examName, receipts, held, addReceipt, dismissHeld, environment, tee],
  );
  return <BoardFormContext.Provider value={value}>{props.children}</BoardFormContext.Provider>;
}

export function useBoardForm(): BoardForm {
  const form = useContext(BoardFormContext);
  if (!form) throw new Error('useBoardForm needs BoardFormProvider');
  return form;
}

/** The plan, evaluated again each time it changes. */
export function useEvaluated() {
  const { plan } = useBoardForm();
  return useMemo(() => evaluatePlan(plan), [plan]);
}

/** A read-only registry for the board area, from the same environment that publishing uses. */
export function useReader(): ExamRegistry | null {
  const { environment } = useBoardForm();
  return useMemo(() => environment.createRegistry?.() ?? null, [environment]);
}
