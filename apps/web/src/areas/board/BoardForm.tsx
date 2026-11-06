import type { ExamRegistry } from '@paperseal/chain';
import { examIdFromName, type Hex } from '@paperseal/protocol';
import type { TeeClient } from '@paperseal/tee-client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { tee as defaultTee } from '../../shared/tee';
import { isBlank, loadDraft, newDraftId, removeDraft, saveDraft } from './draftStore';
import { emptyPublish, type PublishInput } from './form';
import { defaultPlan, defaultRpcHost, evaluatePlan, type DraftStep, type PlanInput } from './plan';
import type { PostOutcome } from './postFlow';
import { defaultEnvironment, type PublishEnvironment, type PublishOutcome } from './publishFlow';

/*
 * The form lives here, in the board route area, so moving between steps keeps what was typed. It
 * starts empty, and once something is typed it is a draft kept in this browser (`draftStore.ts`)
 * under an id in the route, until the exam is published. Receipts are this session's read-backs
 * of what was posted.
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
  /** The saved draft this form is. Null until something is typed. */
  draftId: string | null;
  /** The route names a draft that is not in this browser. */
  draftMissing: boolean;
  /** Forgets the draft, once it has become an exam. */
  resetDraft: () => void;
  /** The published exam's name. ExamRegistry stores only its hash, so this lasts for the session. */
  examName: string | null;
  /** True once for an exam this session just published, so its name is asked for in the wallet by itself, once. */
  claimNamePrompt: (examId: Hex) => boolean;
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

interface FormState {
  /** The saved draft this form is, once something has been typed. */
  draftId: string | null;
  plan: PlanInput;
  publish: PublishInput;
  draftStep: DraftStep;
  /** The draft in the route this state was made for. */
  routeId: string | null;
  /** The route names a draft that is not in this browser. */
  missing: boolean;
}

const blankForm = (routeId: string | null, missing = false): FormState => ({
  draftId: null,
  plan: defaultPlan,
  publish: { ...emptyPublish, rpcHost: defaultRpcHost() },
  draftStep: 'create',
  routeId,
  missing,
});

/** An empty form, or the saved draft the route names. Nothing is restored unless the route asks. */
function formFor(routeId: string | null): FormState {
  if (!routeId) return blankForm(null);
  const draft = loadDraft(routeId);
  if (!draft) return blankForm(routeId, true);
  return {
    draftId: draft.id,
    plan: draft.plan,
    publish: { ...emptyPublish, ...draft.publish, rpcHost: draft.publish.rpcHost || defaultRpcHost() },
    draftStep: draft.draftStep,
    routeId,
    missing: false,
  };
}

export function BoardFormProvider(props: {
  environment?: PublishEnvironment | undefined;
  tee?: TeeClient | null | undefined;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const routeId = /\/draft\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? null;
  const [form, setForm] = useState<FormState>(() => formFor(routeId));
  const [receipts, setReceipts] = useState<readonly Receipt[]>([]);
  const [held, setHeld] = useState<Receipt | null>(null);
  const [examName, setExamName] = useState<string | null>(null);
  const { environment: given, tee: givenTee } = props;
  const environment = useMemo(() => given ?? defaultEnvironment(), [given]);
  const tee = givenTee === undefined ? defaultTee : givenTee;
  const { plan, publish, draftStep, draftId } = form;
  const latest = useRef(form);
  useEffect(() => {
    latest.current = form;
  });

  // The form follows the route. A draft this form just made is already what the route names.
  if (routeId !== form.routeId) {
    setForm(routeId === form.draftId ? { ...form, routeId } : formFor(routeId));
  }

  // Nothing is saved until something is typed, so empty drafts never pile up. The first keystroke
  // makes the draft and puts its id in the route, so a reload stays on it. Clearing it all removes it.
  const change = useCallback(
    (patch: Partial<Pick<FormState, 'plan' | 'publish' | 'draftStep'>>) => {
      const next = { ...latest.current, ...patch };
      if (isBlank(next)) {
        if (next.draftId !== null) removeDraft(next.draftId);
        next.draftId = null;
      } else {
        const created = next.draftId === null;
        next.draftId ??= newDraftId();
        saveDraft(next.draftId, next);
        if (created) void navigate(`/board/draft/${next.draftId}`, { replace: true });
      }
      latest.current = next;
      setForm(next);
    },
    [navigate],
  );
  const setPlan = useCallback(
    (next: PlanInput) => {
      change({ plan: next });
    },
    [change],
  );
  const setPublish = useCallback(
    (next: PublishInput) => {
      change({ publish: next });
    },
    [change],
  );
  const setDraftStep = useCallback(
    (next: DraftStep) => {
      change({ draftStep: next });
    },
    [change],
  );
  const resetDraft = useCallback(() => {
    if (latest.current.draftId) removeDraft(latest.current.draftId);
    const blank = blankForm(latest.current.routeId);
    latest.current = blank;
    setForm(blank);
  }, []);
  const namePrompts = useRef(new Set<string>());
  const claimNamePrompt = useCallback((examId: Hex) => namePrompts.current.delete(examId.toLowerCase()), []);
  const addReceipt = useCallback((receipt: Receipt) => {
    setReceipts((previous) => [...previous, receipt]);
    if (mustBeSeen(receipt)) setHeld(receipt);
    if (receipt.kind === 'publish' && receipt.outcome.matches) {
      setExamName(receipt.name);
      namePrompts.current.add(examIdFromName(receipt.name).toLowerCase());
    }
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
      draftId,
      draftMissing: form.missing,
      resetDraft,
      examName,
      claimNamePrompt,
      receipts,
      held,
      addReceipt,
      dismissHeld,
      environment,
      tee,
    }),
    [plan, setPlan, publish, setPublish, draftStep, setDraftStep, draftId, form.missing, resetDraft, examName, claimNamePrompt, receipts, held, addReceipt, dismissHeld, environment, tee],
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
