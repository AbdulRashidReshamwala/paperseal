import { roundTimeSeconds } from '@paperseal/protocol';
import { Check, Countdown, Stage } from '@paperseal/ui';

import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { useNow } from './hooks';
import { sayOf } from './details';
import { bankNeeded, formatTimeOnly, plainWords } from './plan';

function Questions(props: { snapshot: Snapshot }) {
  const { status, found, teeProblem } = props.snapshot;
  if (!status) {
    return (
      <div>
        <p className="ps-eyebrow">Questions received</p>
        <Check status="not-checked">{teeProblem ? plainWords(sayOf(teeProblem)) : 'Paper Seal has not answered yet.'}</Check>
      </div>
    );
  }
  const needed = found?.criteria ? bankNeeded(found.criteria).questions : null;
  return (
    <div>
      <p className="ps-eyebrow">Questions received</p>
      <p className="board-figure">
        <strong>{status.questionCount}</strong>
        {needed === null ? null : <span> of at least {needed}</span>}
      </p>
      {needed === null ? null : <progress className="board-progress" aria-label="Questions received" max={needed} value={Math.min(status.questionCount, needed)} />}
    </div>
  );
}

/** Step 5: there is nothing to do here until the paper is built. */
export function WaitStep(props: { snapshot: Snapshot }) {
  const { snapshot } = props;
  const now = useNow();
  const settings = snapshot.found?.exam.settings;
  const lockRound = Number(settings?.lockRound ?? 0);
  const lockSeconds = roundTimeSeconds(lockRound);
  const closed = now >= lockSeconds * 1000;
  const stage = snapshot.status?.stage;

  if (stage === 'failed') {
    return (
      <Stage
        title="The paper could not be built"
        lede="This can happen when setters did not send enough questions. The exam cannot go ahead until it is fixed."
        next="Contact whoever runs Paper Seal and tell them what you see here. You can close this page."
      >
        <div className="board-summary">
          <Questions snapshot={snapshot} />
        </div>
        <ExamRecord snapshot={snapshot} />
      </Stage>
    );
  }
  return (
    <Stage
      title={closed ? 'The paper is being built' : `Nothing to do until ${formatTimeOnly(lockSeconds)}`}
      lede={
        closed
          ? 'Questions have closed. Paper Seal is building the paper. You do not need to do anything.'
          : stage === 'onboard'
            ? 'Your list of people is posted. Setters can start sending questions soon.'
            : 'Setters are sending questions. You do not need to do anything now.'
      }
      next={
        closed
          ? 'This page changes by itself when the paper is ready. You must then post its record here, and no one else can do it for you. If you close this page, come back later.'
          : `Come back after ${formatTimeOnly(lockSeconds)}. You must then post the paper’s record here, and no one else can do it for you. It is safe to close this page until then.`
      }
    >
      <div className="board-summary">
        <Questions snapshot={snapshot} />
        <Countdown at={lockSeconds * 1000} round={lockRound} label="Questions close" reached="Closed" />
      </div>
      <ExamRecord snapshot={snapshot} />
    </Stage>
  );
}
