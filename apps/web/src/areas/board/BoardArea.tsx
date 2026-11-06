import type { TeeClient } from '@paperseal/tee-client';
import { Page, RoleHeader, Stage } from '@paperseal/ui';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Hex } from '@paperseal/protocol';

import { Area, type AreaScreen } from '../../shared/Area';
import { useCurrentExamId } from '../../shared/currentExam';
import { TEE_STATUS_POLL_MS } from '../../shared/TeeStatus';
import './board.css';
import { BoardFormProvider, useBoardForm, useEvaluated, useReader } from './BoardForm';
import { BoardHome } from './BoardHome';
import { BuildStep } from './BuildStep';
import { DetailsStep, TopicsStep } from './CreateStep';
import { DraftShell } from './DraftFrame';
import { decideStep, readSnapshot, type Snapshot } from './examState';
import { usePoll } from './hooks';
import { PeopleStep } from './PeopleStep';
import { Fold } from './Parts';
import { PartyStep } from './PartyStep';
import { centresProblem, draftScreen, furthestStep, neutralsProblem, plainWords } from './plan';
import type { PublishEnvironment } from './publishFlow';
import { evaluatePublish } from './form';
import { ReceiptStep } from './ReceiptStep';
import { useReleases } from './releases';
import { ReviewStep } from './ReviewStep';
import { StatusStep } from './StatusStep';
import { WaitStep } from './WaitStep';

const step = (n: number) => `Step ${String(n)} of 6`;

/** The pages before there is an exam. They live in the browser until the exam is published. */
function Draft(props: { review: boolean }) {
  const { plan, publish, draftStep, setDraftStep } = useBoardForm();
  const { blueprint, schedule } = useEvaluated();
  const releases = useReleases(publish.version);
  const { review } = props;

  // `/board/publish` opens at the review, once the form is there to review.
  useEffect(() => {
    if (review) setDraftStep('review');
  }, [review, setDraftStep]);

  const details = Boolean(blueprint.examId && schedule.settings && !evaluatePublish(publish, null).errors.rpcHost);
  const ready = {
    details,
    topics: details && Boolean(blueprint.criteria),
    centres: centresProblem(plan.parties) === null,
    neutrals: neutralsProblem(plan.parties) === null,
  };
  const screen = draftScreen(draftStep, ready);
  const rail = { step: screen, furthest: furthestStep(ready), onStep: setDraftStep };
  if (screen === 'create') {
    return (
      <DetailsStep
        rail={rail}
        onContinue={() => {
          setDraftStep('topics');
        }}
      />
    );
  }
  if (screen === 'topics') {
    return (
      <TopicsStep
        rail={rail}
        onBack={() => {
          setDraftStep('create');
        }}
        onContinue={() => {
          setDraftStep('centres');
        }}
      />
    );
  }
  if (screen === 'centres' || screen === 'neutrals') {
    return (
      <PartyStep
        key={screen}
        kind={screen}
        rail={rail}
        onBack={() => {
          setDraftStep(screen === 'centres' ? 'topics' : 'centres');
        }}
        onContinue={() => {
          setDraftStep(screen === 'centres' ? 'neutrals' : 'review');
        }}
      />
    );
  }
  return (
    <DraftShell {...rail}>
      <ReviewStep
        releases={releases}
        onBack={() => {
          setDraftStep('neutrals');
        }}
      />
    </DraftShell>
  );
}

function useExamState(examId: Hex | null) {
  const reader = useReader();
  const { tee } = useBoardForm();
  const load = useMemo(
    () => (reader && examId ? (previous: Snapshot | null) => readSnapshot({ registry: reader, tee, examId }, previous) : null),
    [reader, tee, examId],
  );
  const poll = usePoll(load, TEE_STATUS_POLL_MS);
  return { reader, ...poll };
}

function Waiting(props: { title: string; lede?: string; next: string; details?: string }) {
  return (
    <Stage title={props.title} {...(props.lede ? { lede: props.lede } : {})} next={props.next}>
      {props.details ? (
        <Fold summary="Details">
          <p className="ps-mono">{props.details}</p>
        </Fold>
      ) : null}
    </Stage>
  );
}

const asExamId = (text: string | null | undefined): Hex | null => (text && /^0x[0-9a-fA-F]{64}$/.test(text) ? (text.toLowerCase() as Hex) : null);

/*
 * What a route asks for. `new` is the create page with an empty form (and an exam named in `?exam=`), `review` its review, `draft`
 * a saved draft named in the route, `exam` the exam named in the route and `current` an old link to
 * the exam this browser last published.
 */
type Mode = 'new' | 'review' | 'draft' | 'exam' | 'current';

/** One screen. Without an exam in the route that is the create page, never a restored draft. */
function BoardFlow(props: { mode: Mode }) {
  const navigate = useNavigate();
  const form = useBoardForm();
  const params = useParams();
  const [search] = useSearchParams();
  const stored = useCurrentExamId();
  const { mode } = props;
  // `?exam=` on the start page names an exam too, so a link to one still works.
  const examId = asExamId(mode === 'exam' ? params.examId : mode === 'current' ? stored : mode === 'new' ? search.get('exam') : null);
  const { reader, value, problem, pending, reload } = useExamState(examId);
  const decided = value ? decideStep(value) : null;
  const page = (children: ReactNode) => (
    <Page header={<RoleHeader role="Exam board" {...(form.examName ? { exam: form.examName } : {})} />}>{children}</Page>
  );
  const withLink = (children: ReactNode) =>
    page(
      <>
        {children}
        <p className="board-quiet">
          <Link to="/board">All your exams and drafts</Link>
        </p>
      </>,
    );

  if (form.held) {
    return page(
      <ReceiptStep
        eyebrow={step(form.held.kind === 'publish' ? 2 : form.held.kind === 'list' ? 3 : 5)}
        receipt={form.held}
        onContinue={() => {
          if (form.held?.kind === 'publish') {
            form.resetDraft();
            void navigate('/board');
          }
          form.dismissHeld();
        }}
      />,
    );
  }
  if (mode === 'draft' && form.draftMissing) return <Navigate to="/board" replace />;
  if ((mode === 'exam' || mode === 'current') && !examId) return <Navigate to="/board" replace />;
  if (!examId) return page(<Draft review={mode === 'review'} />);
  if (!reader) {
    return withLink(
      <Waiting
        title="This page is not ready to use yet"
        lede="Ask whoever installed Paper Seal to finish setting it up."
        next="Come back once they have. It is safe to close this page."
        details="The page needs VITE_RPC_URL and VITE_REGISTRY_ADDRESS to be set."
      />,
    );
  }
  if (!value) {
    return withLink(
      pending ? (
        <Waiting title="Loading your exam" next="The next step appears here by itself. It is safe to close this page." />
      ) : (
        <Waiting
          title="Your exam cannot be loaded right now"
          lede="Check your internet connection. You do not need to do anything else."
          next="This page tries again by itself. It is safe to close it and come back later."
          {...(problem ? { details: plainWords(problem) } : {})}
        />
      ),
    );
  }
  if (decided === 'draft') {
    return withLink(
      <Waiting
        title="We cannot find this exam"
        lede="It may not be on the public record yet, or this may be the wrong exam."
        next="This page looks again by itself. It is safe to close it and come back later."
      />,
    );
  }
  if (decided === 'people') return withLink(<PeopleStep eyebrow={step(3)} snapshot={value} onPosted={reload} />);
  if (decided === 'wait') return withLink(<WaitStep eyebrow={step(4)} snapshot={value} />);
  if (decided === 'post-build') return withLink(<BuildStep eyebrow={step(5)} snapshot={value} onPosted={reload} />);
  return withLink(<StatusStep eyebrow={step(6)} snapshot={value} />);
}

/** `/board` is the home list, unless `?exam=` names an exam, which an older link still opens. */
function BoardIndex() {
  const [search] = useSearchParams();
  return asExamId(search.get('exam')) ? <BoardFlow mode="new" /> : <BoardHome />;
}

/*
 * `/board` is the list of exams and drafts, `/board/new` the create page, and an exam or draft is
 * reached by its own route. The old `blueprint` and `schedule` links go to the create page and
 * `publish` opens its review, and the old `onboarding`, `list` and `outbox` links open the exam this
 * browser last published.
 */
export const screens: AreaScreen[] = [
  { path: '', element: <BoardIndex /> },
  { path: 'new', element: <BoardFlow mode="new" /> },
  { path: 'draft/:draftId', element: <BoardFlow mode="draft" /> },
  { path: 'exam/:examId', element: <BoardFlow mode="exam" /> },
  { path: 'blueprint', element: <Navigate to="/board/new" replace /> },
  { path: 'schedule', element: <Navigate to="/board/new" replace /> },
  { path: 'publish', element: <BoardFlow mode="review" /> },
  { path: 'onboarding', element: <BoardFlow mode="current" /> },
  { path: 'list', element: <BoardFlow mode="current" /> },
  { path: 'outbox', element: <BoardFlow mode="current" /> },
];

export default function BoardArea(props: { environment?: PublishEnvironment; tee?: TeeClient | null }) {
  return (
    <BoardFormProvider environment={props.environment} tee={props.tee}>
      <Area screens={screens} />
    </BoardFormProvider>
  );
}
