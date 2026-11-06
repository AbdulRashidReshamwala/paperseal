import { roundTimeSeconds } from '@paperseal/protocol';

import { decideStep, type Snapshot } from './examState';
import { useNow } from './hooks';
import { formatTimeOnly } from './plan';
import { sealStateAt } from './StatusStep';

const LAST = 5;

/** Which step of the exam's life the board is on. It reads the same state that picks the screen. */
function spotOf(snapshot: Snapshot, now: number, times: { lock: number; unlock: number; end: number }): number {
  const step = decideStep(snapshot);
  if (step === 'draft' || step === 'people') return 0;
  if (step === 'post-build') return 2;
  if (step === 'wait') return snapshot.status?.stage !== 'failed' && now >= times.lock * 1000 ? 2 : 1;
  return { sealed: 3, opening: 4, open: LAST }[sealStateAt(now, times.unlock * 1000, times.end * 1000)];
}

/** The exam's whole life at a glance. It only shows where things stand: the state decides the screen, so nothing here is pressed. */
export function ExamJourney(props: { snapshot: Snapshot }) {
  const { snapshot } = props;
  const now = useNow();
  const settings = snapshot.found?.exam.settings;
  const times = {
    lock: roundTimeSeconds(Number(settings?.lockRound ?? 0)),
    unlock: roundTimeSeconds(Number(settings?.unlockRound ?? 0)),
    end: roundTimeSeconds(Number(settings?.endRound ?? 0)),
  };
  const steps: { label: string; when?: string }[] = [
    { label: 'Bring everyone in' },
    { label: 'Questions come in', when: `Until ${formatTimeOnly(times.lock)}` },
    { label: 'Post the paper’s record' },
    { label: 'Paper sealed' },
    { label: 'Paper released to centres', when: formatTimeOnly(times.unlock) },
    { label: 'Paper opens to everyone', when: formatTimeOnly(times.end) },
  ];
  const here = spotOf(snapshot, now, times);
  const over = here === LAST;
  return (
    <ol className="board-journey" aria-label="Where this exam is">
      {steps.map(({ label, when }, index) => {
        const done = index < here || over;
        return (
          <li key={label} data-state={index === here ? 'here' : done ? 'done' : 'ahead'} data-over={over ? 'true' : undefined} aria-current={index === here ? 'step' : undefined}>
            <span className="board-journey-mark" aria-hidden="true">
              {done ? '✓' : index + 1}
            </span>
            <span className="board-journey-text">
              <span>{label}</span>
              {when ? <small>{when}</small> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
