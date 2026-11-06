import type { Hex } from '@paperseal/protocol';
import { Button } from '@paperseal/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useBoardForm, useReader } from './BoardForm';
import type { Snapshot } from './examState';
import { noteMachineChecked } from './ExamJourney';
import { listKnownExams } from './examsStore';
import { checkMachineReady, type ReadyResult } from './machineReady';
import { Fold } from './Parts';

const otherExam = (id: Hex): string => listKnownExams().find((exam) => exam.id === id)?.name ?? `exam ${id.slice(2, 10)}`;

/** Tests only the machine, above the people step, so the board knows it can take registrations before asking anyone. It never holds the page up. */
export function OnboardCheck(props: { examId: Hex; snapshot: Snapshot; children: ReactNode }) {
  const { tee } = useBoardForm();
  const registry = useReader()?.address ?? null;
  const exam = props.snapshot.found?.exam ?? null;
  const [round, setRound] = useState(0);
  const [done, setDone] = useState<{ round: number; result: ReadyResult } | null>(null);

  useEffect(() => {
    if (!exam || !registry) return;
    let live = true;
    void checkMachineReady(tee, { examId: props.examId, exam, registry, otherExam }).then((result) => {
      if (live) {
        setDone({ round, result });
        noteMachineChecked(props.examId, result.ok);
      }
    });
    return () => {
      live = false;
    };
  }, [tee, props.examId, exam, registry, round]);

  if (!exam || !registry) return props.children;
  if (!done || done.round !== round) {
    return (
      <>
        <h1 className="board-draft-title">Machine Check</h1>
        <p className="board-machine-line" role="status">
          Checking the machine
        </p>
      </>
    );
  }
  const { result } = done;
  if (result.ok) {
    return (
      <>
        <p className="board-machine-line" data-tone="good" role="status">
          Machine checked just now
        </p>
        {props.children}
      </>
    );
  }
  return (
    <>
      <h1 className="board-draft-title">Machine Check</h1>
      <section className="board-machine" data-tone="problem" aria-label="Machine check">
      <div className="board-machine-text" role="status">
        <strong>{result.title}</strong>
        <p>{result.lede}</p>
        <p>{result.next}</p>
      </div>
      <Button
        onClick={() => {
          setRound((n) => n + 1);
        }}
      >
        Check again
      </Button>
      {result.details ? (
        <Fold summary="Details">
          <p className="ps-mono board-machine-details">{result.details}</p>
        </Fold>
      ) : null}
      </section>
    </>
  );
}
