import { roundTimeSeconds } from '@paperseal/protocol';
import { Check, Countdown, Stage } from '@paperseal/ui';

import { ExamRecord } from './ExamRecord';
import type { Snapshot } from './examState';
import { useNow } from './hooks';
import { bankNeeded, formatTimeOnly, plainWords } from './plan';

function Questions(props: { snapshot: Snapshot }) {
  const { status, found, teeProblem } = props.snapshot;
  if (!status) {
    return (
      <p>
        <Check status="not-checked">{teeProblem ? plainWords(teeProblem) : 'The sealed machine has not answered yet.'}</Check>
      </p>
    );
  }
  const needed = found?.criteria ? bankNeeded(found.criteria).questions : null;
  return (
    <div className="board-section">
      <p className="ps-eyebrow">Questions received</p>
      <p>{needed === null ? status.questionCount : `${String(status.questionCount)} of at least ${String(needed)}`}</p>
      {needed === null ? null : <progress className="board-progress" aria-label="Questions received" max={needed} value={Math.min(status.questionCount, needed)} />}
    </div>
  );
}

/** Step 5: there is nothing to do here. The sealed machine runs Lock and Build by itself. */
export function WaitStep(props: { eyebrow: string; snapshot: Snapshot }) {
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
        eyebrow={props.eyebrow}
        title="The sealed machine stopped"
        lede="It reported a failure. If the questions did not meet the setter limits, the paper cannot be built and the exam cannot go ahead."
        next="Ask whoever runs the sealed machine to check its log. Nothing more can happen here until it recovers."
      >
        <Questions snapshot={snapshot} />
        <ExamRecord snapshot={snapshot} />
      </Stage>
    );
  }
  return (
    <Stage
      eyebrow={props.eyebrow}
      title={closed ? 'The sealed machine is building the paper' : `Nothing to do until ${formatTimeOnly(lockSeconds)}`}
      lede={
        closed
          ? 'Questions have closed. The sealed machine locks the question bank and builds the paper by itself.'
          : stage === 'onboard'
            ? 'The list is posted. The sealed machine reads it once it is final, which can take about 20 minutes, and setters can then send questions.'
            : 'Setters are sending questions. The sealed machine locks them in and builds the paper by itself.'
      }
      next={closed ? 'You post the finished paper’s record here, as soon as it is ready.' : 'When questions close, the sealed machine builds the paper. You post its record here.'}
    >
      <Questions snapshot={snapshot} />
      <Countdown at={lockSeconds * 1000} round={lockRound} label="Questions close" reached="Closed" />
      <ExamRecord snapshot={snapshot} />
    </Stage>
  );
}
