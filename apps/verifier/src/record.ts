import type { Tone } from '@paperseal/ui';

import type { CustodyStep, Failure, StepId } from './custody';
import { sourceWords, stateWords, type Copies, type CopySource, type CopyState, type Moment, type PieceId } from './facts';

/*
 * How the exam page arranges what custody.ts and facts.ts decide. Nothing here runs or changes a
 * check: it only orders, numbers and groups results that were made elsewhere.
 */

/**
 * The steps as the page lists them: what has happened, in the order it happened, then what is still
 * to come, in the order the protocol runs it. Each is numbered by where it now stands.
 */
export function shownOrder(steps: readonly CustodyStep[]): CustodyStep[] {
  // A finished step with no recorded time stays just after the finished step before it.
  let latest = -Infinity;
  const done = steps.flatMap((step, index) => {
    if (step.state !== 'done') return [];
    if (step.at !== null) latest = Math.max(latest, step.at);
    return [{ step, index, at: step.at ?? latest }];
  });
  done.sort((a, b) => a.at - b.at || a.index - b.index);
  const rest = steps.filter((step) => step.state !== 'done');
  return [...done.map(({ step }) => step), ...rest].map((step, index) => ({ ...step, number: index + 1 }));
}

/** Each step's number in the protocol, mapped to its number on the page. */
export function shownNumbers(steps: readonly CustodyStep[], shown: readonly CustodyStep[]): Map<number, number> {
  const at = new Map(shown.map((step) => [step.id, step.number]));
  return new Map(steps.map((step) => [step.number, at.get(step.id) ?? step.number]));
}

/** A sentence that points at a step by number, pointed at the number the page shows. */
export function renumbered(text: string, numbers: ReadonlyMap<number, number>): string {
  return text.replace(/\b([Ss])tep (\d+)\b/g, (whole, s: string, n: string) => {
    const shown = numbers.get(Number(n));
    return shown === undefined ? whole : `${s}tep ${String(shown)}`;
  });
}

/** The alarm's failures, numbered as the page lists the steps. */
export function shownFailures(failures: readonly Failure[], numbers: ReadonlyMap<number, number>): Failure[] {
  return failures.map((failure) => ({ ...failure, step: numbers.get(failure.step) ?? failure.step, message: renumbered(failure.message, numbers) }));
}

/** Which step each moment of the timeline belongs to. The exam's start is a fact of its own, not a step. */
const momentSteps: Record<string, StepId> = {
  published: 'published',
  list: 'people',
  lock: 'locked',
  built: 'sealed',
  unlock: 'unlock',
  end: 'open',
};

/** A moment's note against the schedule, keyed by the step it adds to. */
export function momentNotes(moments: readonly Moment[]): Map<StepId, string> {
  const notes = new Map<StepId, string>();
  for (const moment of moments) {
    const step = momentSteps[moment.id];
    if (step && moment.note) notes.set(step, notes.has(step) ? `${notes.get(step) ?? ''} ${moment.note}` : moment.note);
  }
  return notes;
}

/* ------------------------------------------------------------------ Evidence at a glance */

/** The places a table column can be. The sealed machine only reports progress, so it stays in the details. */
const columns: readonly CopySource[] = ['registry', 'bucket', 'arkiv', 'swarm'];

/** A failure to read or to pass is set apart from a copy that is simply not there yet. */
const cellTones: Record<CopyState, Tone> = {
  checked: 'ok',
  held: 'neutral',
  reading: 'neutral',
  missing: 'neutral',
  unread: 'bad',
  off: 'neutral',
  failed: 'bad',
};

export type EvidenceCell = { kind: 'none' } | { kind: 'copy'; state: CopyState; word: string; tone: Tone; used: boolean };

export interface EvidenceTable {
  sources: { id: CopySource; label: string }[];
  rows: { id: PieceId; label: string; cells: EvidenceCell[] }[];
}

/** Every piece against every place that keeps one, each cell in the words the details use. */
export function evidenceTable(found: Copies): EvidenceTable {
  const present = columns.filter((source) => found.pieces.some((piece) => piece.copies.some((copy) => copy.source === source)));
  return {
    sources: present.map((id) => ({ id, label: sourceWords[id] })),
    rows: found.pieces.map((piece) => ({
      id: piece.id,
      label: piece.label,
      cells: present.map((source): EvidenceCell => {
        const copy = piece.copies.find((held) => held.source === source);
        if (!copy) return { kind: 'none' };
        return { kind: 'copy', state: copy.state, word: stateWords[copy.state].word, tone: cellTones[copy.state], used: copy.used === true };
      }),
    })),
  };
}
