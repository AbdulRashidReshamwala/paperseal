import { looksLikeEnsName } from '@paperseal/protocol';
import type { TeeClient } from '@paperseal/tee-client';
import { Button, LoadingSeal, Page, RoleHeader, Stage } from '@paperseal/ui';
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Hex } from '@paperseal/protocol';

import { Area, type AreaScreen } from '../../shared/Area';
import { useCurrentExamId } from '../../shared/currentExam';
import { demoPanel } from '../../shared/demoKeys';
import { TEE_STATUS_POLL_MS } from '../../shared/TeeStatus';
import './board.css';
import { shortExamId } from '../../shared/examName';
import { BoardFormProvider, useBoardForm, useEvaluated, useReader, useVerifiedName } from './BoardForm';
import { BoardHome } from './BoardHome';
import { BuildStep } from './BuildStep';
import { DetailsStep, TopicsStep } from './CreateStep';
import { DraftShell, ExamShell } from './DraftFrame';
import { ExamNameCard } from './ExamNameCard';
import { decideStep, readSnapshot, type Snapshot } from './examState';
import { usePoll } from './hooks';
import { MachineCheck } from './MachineCheck';
import { OnboardCheck } from './OnboardCheck';
import { PeopleStep } from './PeopleStep';
import { openExamName, type ExamNameRoute } from './nameFlow';
import { loadParties, type ChosenParty } from './parties';
import { Fold, Problem } from './Parts';
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

const DemoPanel = demoPanel<{ examId: Hex; snapshot: Snapshot; parties: readonly ChosenParty[] }>();

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

/**
 * An ENS name in the exam route. The exam it opens is known only once the name passes every check, and
 * a name verified earlier this session opens at once, so swapping a hex URL for the name loses nothing.
 */
function useNamedExam(param: string | undefined) {
  const { environment, verifiedNames, noteVerifiedName } = useBoardForm();
  const name = param && !asExamId(param) && looksLikeEnsName(param) ? param : null;
  const examId = name ? (verifiedNames.get(name) ?? null) : null;
  const [refused, setRefused] = useState<{ name: string; result: Extract<ExamNameRoute, { ok: false }> } | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!name || examId) return;
    let live = true;
    void openExamName(environment, name).then((result) => {
      if (!live) return;
      if (result.ok) noteVerifiedName(name, result.examId);
      else setRefused({ name, result });
    });
    return () => {
      live = false;
    };
  }, [environment, examId, name, noteVerifiedName, round]);

  const retry = useCallback(() => {
    setRefused(null);
    setRound((n) => n + 1);
  }, []);
  return { name, examId, refused: refused?.name === name ? refused.result : null, retry };
}

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
  const { noteVerifiedName } = form;
  const params = useParams();
  const [search] = useSearchParams();
  const stored = useCurrentExamId();
  const { mode } = props;
  // `?exam=` on the start page names an exam too, so a link to one still works.
  const named = useNamedExam(mode === 'exam' ? params.examId : undefined);
  const examId = named.name ? named.examId : asExamId(mode === 'exam' ? params.examId : mode === 'current' ? stored : mode === 'new' ? search.get('exam') : null);
  const { reader, value, problem, pending, reload } = useExamState(examId);
  const decided = value ? decideStep(value) : null;
  const verifiedName = useVerifiedName(examId);
  const page = (children: ReactNode) => (
    <Page header={<RoleHeader role="Exam board" {...(examId ? { exam: verifiedName ?? shortExamId(examId) } : {})} />}>{children}</Page>
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
  if (named.name && !examId) {
    if (!named.refused) return page(<LoadingSeal />);
    return withLink(
      <Stage
        title="This exam could not be opened"
        {...(named.refused.retry ? { action: <Button onClick={named.retry}>Try again</Button> } : {})}
        next="Open the exam from your list, or ask whoever sent you this link to check the name."
      >
        <Problem>{named.refused.message}</Problem>
      </Stage>,
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
        <LoadingSeal />
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
  // Once the name passes, it replaces the ID in the address. The route stays this component, so nothing reloads.
  const verifiedAs = (name: string) => {
    noteVerifiedName(name, examId);
    if (named.name !== name) void navigate(`/board/exam/${name}`, { replace: true });
  };
  const onExam = (children: ReactNode) =>
    page(
      <ExamShell snapshot={value}>
        <div className="board-strip">
          <MachineCheck examId={examId} snapshot={value} />
          <ExamNameCard key={examId} examId={examId} routeName={named.name} onVerified={verifiedAs} />
        </div>
        {children}
        {DemoPanel ? (
          <Suspense fallback={null}>
            <DemoPanel examId={examId} snapshot={value} parties={loadParties(examId)} />
          </Suspense>
        ) : null}
      </ExamShell>,
    );
  if (decided === 'people') {
    return onExam(
      <>
        <OnboardCheck examId={examId} snapshot={value} />
        <PeopleStep examId={examId} snapshot={value} onPosted={reload} />
      </>,
    );
  }
  if (decided === 'wait') return onExam(<WaitStep snapshot={value} />);
  if (decided === 'post-build') return onExam(<BuildStep examId={examId} snapshot={value} onPosted={reload} />);
  return onExam(<StatusStep examId={examId} snapshot={value} />);
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
