import type { Hex } from '@paperseal/protocol';
import { Button } from '@paperseal/ui';
import { useEffect, useMemo, useState } from 'react';

import { useBoardForm, useReader } from './BoardForm';
import type { Snapshot } from './examState';
import { listKnownExams } from './examsStore';
import { useNow, usePoll } from './hooks';
import {
  examFinished,
  judgeMachine,
  MACHINE_POLL_MS,
  machineState,
  machineWords,
  readMachine,
  type ChainExam,
  type MachineRead,
  type MachineState,
  type MachineVerdict,
} from './machineVerdict';
import { Fold } from './Parts';

/** Asks the machine, once for the page, while something on it still needs an answer. */
export function useMachineRead(needed: boolean): { read: MachineRead | null; reload: () => void } {
  const { tee } = useBoardForm();
  const load = useMemo(() => (needed ? (previous: MachineRead | null) => readMachine(tee, previous) : null), [needed, tee]);
  const { value, reload } = usePoll(load, MACHINE_POLL_MS);
  return { read: value, reload };
}

const keyOf = (exams: ReadonlyMap<Hex, ChainExam>) => [...exams.keys()].join(',');

/** Compares the machine's one answer with each exam. ExamRegistry is write-once, so an exam's ID stands for its contents. */
export function useMachineVerdicts(read: MachineRead | null, exams: ReadonlyMap<Hex, ChainExam>): ReadonlyMap<Hex, MachineVerdict> {
  const reader = useReader();
  const registry = reader?.address ?? null;
  const [held, setHeld] = useState(exams);
  if (keyOf(held) !== keyOf(exams)) setHeld(exams);
  const [verdicts, setVerdicts] = useState<ReadonlyMap<Hex, MachineVerdict>>(new Map());

  useEffect(() => {
    if (!read || !registry) return;
    let live = true;
    const judged = [...held].map(async ([examId, exam]) => [examId, await judgeMachine(read, { examId, exam, registry })] as const);
    void Promise.all(judged).then((entries) => {
      if (live) setVerdicts(new Map(entries));
    });
    return () => {
      live = false;
    };
  }, [read, held, registry]);

  return verdicts;
}

const otherExam = (id: Hex): string => listKnownExams().find((exam) => exam.id === id)?.name ?? `exam ${id.slice(2, 10)}`;

/** The short state under a row's status on the home list. */
export function MachineRowStatus(props: { state: MachineState }) {
  const words = machineWords(props.state, { otherExam, listPosted: false });
  return (
    <span className="board-home-machine" data-tone={words.tone}>
      {words.short}
    </span>
  );
}

/** Whether the machine is set up for this exam, in the strip at the top of the exam's page. It never holds the page up. */
export function MachineCheck(props: { examId: Hex; snapshot: Snapshot }) {
  const { examId, snapshot } = props;
  const exam = snapshot.found?.exam ?? null;
  const now = useNow(30_000);
  const { read, reload } = useMachineRead(exam !== null && !examFinished(exam, now));
  const exams = useMemo(() => new Map(exam ? [[examId, exam]] : []), [examId, exam]);
  const verdict = useMachineVerdicts(read, exams).get(examId) ?? null;
  // Pressing Try again shows Checking until an answer replaces the verdict it was pressed on.
  const [retrying, setRetrying] = useState<{ on: MachineVerdict | null } | null>(null);
  if (retrying && retrying.on !== verdict) setRetrying(null);
  if (!exam) return null;

  const state = retrying ? ({ state: 'checking' } as const) : machineState(verdict, exam, now);
  const words = machineWords(state, { otherExam, listPosted: snapshot.list !== null });
  // Nothing to tell a finished exam's board. A healthy machine is one quiet line, and only a problem takes the page's attention.
  if (state.state === 'finished') return null;
  if (words.tone !== 'problem') {
    return (
      <p className="board-machine-line" data-tone={words.tone} role="status" title={words.lede}>
        {words.short}
      </p>
    );
  }
  return (
    <section className="board-machine" data-tone={words.tone} aria-label="The machine for this exam">
      <div className="board-machine-text" role="status">
        <strong>{words.title}</strong>
        <p>{words.lede}</p>
        {words.next ? <p>{words.next}</p> : null}
      </div>
      {words.retry ? (
        <Button
          onClick={() => {
            setRetrying({ on: verdict });
            reload();
          }}
        >
          Try again
        </Button>
      ) : null}
      {words.details ? (
        <Fold summary="Details">
          <p className="ps-mono board-machine-details">{words.details}</p>
        </Fold>
      ) : null}
    </section>
  );
}
