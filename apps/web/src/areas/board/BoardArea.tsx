import type { TeeClient } from '@paperseal/tee-client';
import { Page, RoleHeader, Stage } from '@paperseal/ui';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { Area, type AreaScreen } from '../../shared/Area';
import { useCurrentExamId } from '../../shared/currentExam';
import { TEE_STATUS_POLL_MS } from '../../shared/TeeStatus';
import './board.css';
import { BoardFormProvider, useBoardForm, useEvaluated, useReader } from './BoardForm';
import { BuildStep } from './BuildStep';
import { CreateStep } from './CreateStep';
import { decideStep, readSnapshot, type Snapshot } from './examState';
import { usePoll } from './hooks';
import { PeopleStep } from './PeopleStep';
import { Fold } from './Parts';
import { draftScreen, plainWords } from './plan';
import type { PublishEnvironment } from './publishFlow';
import { evaluatePublish } from './form';
import { ReceiptStep } from './ReceiptStep';
import { useReleases } from './releases';
import { ReviewStep } from './ReviewStep';
import { StatusStep } from './StatusStep';
import { VersionStep } from './VersionStep';
import { WaitStep } from './WaitStep';

const step = (n: number) => `Step ${String(n)} of 7`;

/** Steps 1 to 3, before there is an exam. They live in the browser until the exam is published. */
function Draft(props: { review: boolean; otherExam: boolean }) {
  const { publish, setPublish, draftStep, setDraftStep } = useBoardForm();
  const { blueprint, schedule } = useEvaluated();
  const releases = useReleases(publish.version);
  const { review } = props;

  // `/board/publish` opens at the review, once the form is there to review.
  useEffect(() => {
    if (review) setDraftStep('review');
  }, [review, setDraftStep]);

  const created = Boolean(
    blueprint.criteria && blueprint.examId && schedule.settings && !evaluatePublish(publish, null).errors.rpcHost,
  );
  const screen = draftScreen(draftStep, { create: created, version: releases.verified !== null });
  return (
    <>
      {props.otherExam ? (
        <p className="board-note">
          Another exam is under way. <Link to="/board">Go back to it</Link>, or set up a new one here.
        </p>
      ) : null}
      {screen === 'create' ? (
        <CreateStep
          eyebrow={step(1)}
          onContinue={() => {
            setDraftStep('version');
          }}
        />
      ) : null}
      {screen === 'version' ? (
        <VersionStep
          eyebrow={step(2)}
          releases={releases}
          chosen={publish.version}
          onChoose={(version) => {
            setPublish({ ...publish, version });
          }}
          onContinue={() => {
            setDraftStep('review');
          }}
          onBack={() => {
            setDraftStep('create');
          }}
        />
      ) : null}
      {screen === 'review' ? (
        <ReviewStep
          eyebrow={step(3)}
          releases={releases}
          onBack={() => {
            setDraftStep('create');
          }}
        />
      ) : null}
    </>
  );
}

function useExamState() {
  const examId = useCurrentExamId();
  const reader = useReader();
  const { tee } = useBoardForm();
  const load = useMemo(
    () => (reader && examId ? (previous: Snapshot | null) => readSnapshot({ registry: reader, tee, examId }, previous) : null),
    [reader, tee, examId],
  );
  const poll = usePoll(load, TEE_STATUS_POLL_MS);
  return { examId, reader, ...poll };
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

/** One screen, chosen by the exam's state. `route` only asks for a new exam, or for its review. */
function BoardFlow(props: { route?: 'draft' | 'review' }) {
  const navigate = useNavigate();
  const form = useBoardForm();
  const { examId, reader, value, problem, pending, reload } = useExamState();
  const decided = value ? decideStep(value) : null;
  const page = (children: ReactNode) => (
    <Page header={<RoleHeader role="Exam board" {...(form.examName ? { exam: form.examName } : {})} />}>{children}</Page>
  );

  if (form.held) {
    return page(
      <ReceiptStep
        eyebrow={step(form.held.kind === 'publish' ? 3 : form.held.kind === 'list' ? 4 : 6)}
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
  if (props.route || !examId || decided === 'draft') {
    return page(<Draft review={props.route === 'review'} otherExam={Boolean(decided && decided !== 'draft')} />);
  }
  if (!reader) {
    return page(
      <Waiting
        title="This page is not ready to use yet"
        lede="Ask whoever installed Paper Seal to finish setting it up."
        next="Come back once they have. It is safe to close this page."
        details="The page needs VITE_RPC_URL and VITE_REGISTRY_ADDRESS to be set."
      />,
    );
  }
  if (!value) {
    return page(
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
  if (decided === 'people') return page(<PeopleStep eyebrow={step(4)} snapshot={value} onPosted={reload} />);
  if (decided === 'wait') return page(<WaitStep eyebrow={step(5)} snapshot={value} />);
  if (decided === 'post-build') return page(<BuildStep eyebrow={step(6)} snapshot={value} onPosted={reload} />);
  return page(<StatusStep eyebrow={step(7)} snapshot={value} />);
}

/*
 * Every route shows the same flow, so old links keep working. `blueprint` and `schedule` are how a
 * new exam starts, because a board that already has an exam has no other way to ask for one.
 */
export const screens: AreaScreen[] = [
  { path: '', element: <BoardFlow /> },
  { path: 'blueprint', element: <BoardFlow route="draft" /> },
  { path: 'schedule', element: <BoardFlow route="draft" /> },
  { path: 'publish', element: <BoardFlow route="review" /> },
  { path: 'onboarding', element: <BoardFlow /> },
  { path: 'list', element: <BoardFlow /> },
  { path: 'outbox', element: <BoardFlow /> },
];

export default function BoardArea(props: { environment?: PublishEnvironment; tee?: TeeClient | null }) {
  return (
    <BoardFormProvider environment={props.environment} tee={props.tee}>
      <Area screens={screens} />
    </BoardFormProvider>
  );
}
