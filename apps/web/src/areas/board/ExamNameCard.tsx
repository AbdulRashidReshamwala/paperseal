import { examIdFromName, splitExamEnsName, type Hex } from '@paperseal/protocol';
import { Button, Check, CopyButton, PrimaryAction } from '@paperseal/ui';
import { useCallback, useEffect, useState } from 'react';

import { useBoardForm } from './BoardForm';
import { noteNameSettled, useNameSettled } from './ExamJourney';
import { listKnownExams } from './examsStore';
import { useBoardWallet, walletStageLabels, type WalletStage } from './hooks';
import { readExamName, setExamName, type ExamName } from './nameFlow';
import { Problem } from './Parts';
import { verifierNameUrl, verifierUrl } from './plan';

type View = ExamName | { state: 'checking' } | { state: 'running'; stage: WalletStage };

/** The exam's name: from the route, or as this browser kept it. ExamRegistry stores only its hash. */
function useExamLabel(examId: Hex, routeName: string | null): string | null {
  const { examName } = useBoardForm();
  const kept = [routeName ? splitExamEnsName(routeName)?.label : null, examName, listKnownExams().find((exam) => exam.id === examId.toLowerCase())?.name];
  return kept.find((label) => label && examIdFromName(label).toLowerCase() === examId.toLowerCase()) ?? null;
}

/**
 * The exam's ENS name, on every screen of a published exam. Just after publishing it asks the wallet by
 * itself. Reopened, it only reads: a name that is set shows, and one that isn't offers one button. The
 * exam carries on whatever happens here.
 */
export function ExamNameCard(props: { examId: Hex; routeName?: string | null; onVerified?: (name: string) => void }) {
  const label = useExamLabel(props.examId, props.routeName ?? null);
  useEffect(() => {
    if (!label) noteNameSettled(props.examId, true);
  }, [label, props.examId]);
  return label ? <NameOf examId={props.examId} label={label} {...(props.onVerified ? { onVerified: props.onVerified } : {})} /> : null;
}

function NameOf(props: { examId: Hex; label: string; onVerified?: (name: string) => void }) {
  const { environment, claimNamePrompt } = useBoardForm();
  const { ensureAccount } = useBoardWallet();
  const { label } = props;
  const [view, setView] = useState<View>({ state: 'checking' });

  const send = useCallback(async () => {
    setView({ state: 'running', stage: 'checking' });
    try {
      await ensureAccount();
    } catch {
      // setExamName repeats the wallet's checks and says what is wrong.
    }
    setView(
      await setExamName(environment, label, (stage) => {
        setView({ state: 'running', stage });
      }),
    );
  }, [environment, ensureAccount, label]);

  const read = useCallback(async () => {
    setView({ state: 'running', stage: 'reading' });
    setView(await readExamName(environment, label));
  }, [environment, label]);

  useEffect(() => {
    if (claimNamePrompt(props.examId)) {
      queueMicrotask(() => void send());
      return;
    }
    // Strict mode runs this twice, so a send already under way must keep the screen.
    void readExamName(environment, label).then((found) => {
      setView((current) => (current.state === 'checking' ? found : current));
    });
  }, [claimNamePrompt, environment, label, props.examId, send]);

  const { onVerified } = props;
  const verified = view.state === 'set' ? view.name : null;
  useEffect(() => {
    if (verified) onVerified?.(verified);
  }, [onVerified, verified]);

  const passed = useNameSettled(props.examId);
  const settled = view.state === 'off' || view.state === 'set' || view.state === 'no-primary-name';
  useEffect(() => {
    if (settled) noteNameSettled(props.examId, true);
  }, [settled, props.examId]);

  if (view.state === 'off' || view.state === 'checking') return null;
  // Skipped: the page has moved on, and the name can be set by reopening the exam.
  if (passed && view.state !== 'set' && view.state !== 'running') return null;

  if (view.state === 'set') {
    const verifier = verifierUrl();
    return (
      <div className="board-exam-name">
        <span>
          <span className="board-exam-name-label">Exam name </span>
          <span className="ps-mono">{view.name}</span>
        </span>
        <CopyButton text={view.name}>Copy name</CopyButton>
        {verifier ? (
          <a href={verifierNameUrl(verifier, view.name)} target="_blank" rel="noreferrer">
            Open by name
          </a>
        ) : null}
      </div>
    );
  }

  const running = view.state === 'running';
  return (
    <section className="board-draft-card board-people-job" aria-label="Exam name">
      <h2>Exam Name</h2>
      {view.state === 'failed' || view.state === 'unconfirmed' ? <Problem>{view.message}</Problem> : null}
      {view.state === 'no-primary-name' ? (
        <p className="board-note">
          <Check status="not-checked">{view.message}</Check>
        </p>
      ) : null}
      {view.state === 'unset' || running ? (
        <p className="board-note">
          {view.state === 'unset' ? (
            <>
              <span className="ps-mono">{view.name}</span> is not set yet.{' '}
            </>
          ) : null}
          Anyone can then find and check this exam by its name. Your wallet asks you to confirm once. The exam carries on without it.
        </p>
      ) : null}
      {view.state === 'unset' || running ? (
        <PrimaryAction status={running ? 'busy' : 'idle'} busyLabel={running ? walletStageLabels[view.stage] : ''} onClick={() => void send()}>
          Set the exam name
        </PrimaryAction>
      ) : (
        <Button aria-label="Try again to set the exam name" onClick={() => void (view.state === 'unconfirmed' ? read() : send())}>
          Try again
        </Button>
      )}
      {running ? null : (
        <Button
          onClick={() => {
            noteNameSettled(props.examId, true);
          }}
        >
          Skip for now
        </Button>
      )}
    </section>
  );
}
