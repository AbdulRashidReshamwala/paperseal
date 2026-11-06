import { roundTimeSeconds, type Hex } from '@paperseal/protocol';
import { useSyncExternalStore } from 'react';

import { decideStep, type Snapshot } from './examState';
import { useNow } from './hooks';
import { formatTimeOnly } from './plan';
import { sealStateAt } from './StatusStep';

const LAST = 7;

const checked = new Set<string>();
const named = new Set<string>();
const listeners = new Set<() => void>();

const note = (set: Set<string>, examId: Hex, ok: boolean) => {
  const id = examId.toLowerCase();
  if (ok === set.has(id)) return;
  if (ok) set.add(id);
  else set.delete(id);
  for (const listener of listeners) listener();
};

/** Says the machine test passed for this exam, so the rail can move past it. */
export const noteMachineChecked = (examId: Hex, ok: boolean): void => {
  note(checked, examId, ok);
};

/** Says the exam's name is set, skipped or can't be set here, so the rail and page can move past it. */
export const noteNameSettled = (examId: Hex, ok: boolean): void => {
  note(named, examId, ok);
};

function useIn(set: Set<string>, examId: Hex | undefined): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => examId !== undefined && set.has(examId.toLowerCase()),
  );
}

export const useNameSettled = (examId: Hex): boolean => useIn(named, examId);

/** Which step of the exam's life the board is on. It reads the same state that picks the screen. */
function spotOf(snapshot: Snapshot, now: number, times: { lock: number; unlock: number; end: number }, setup: number): number {
  const step = decideStep(snapshot);
  if (step === 'draft' || step === 'people') return setup;
  if (step === 'post-build') return 4;
  if (step === 'wait') return snapshot.status?.stage !== 'failed' && now >= times.lock * 1000 ? 4 : 3;
  return { sealed: 5, opening: 6, open: LAST }[sealStateAt(now, times.unlock * 1000, times.end * 1000)];
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
    { label: 'Exam Name' },
    { label: 'Machine Check' },
    { label: 'Registration' },
    { label: 'Question Submission', when: `Until ${formatTimeOnly(times.lock)}` },
    { label: 'Paper Build' },
    { label: 'Paper Sealed' },
    { label: 'Paper Release', when: formatTimeOnly(times.unlock) },
    { label: 'Public Opening', when: formatTimeOnly(times.end) },
  ];
  const examId = snapshot.found?.exam.settings.examId as Hex | undefined;
  const nameSettled = useIn(named, examId);
  const machineChecked = useIn(checked, examId);
  const here = spotOf(snapshot, now, times, !nameSettled ? 0 : machineChecked ? 2 : 1);
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
