import { roundTimeSeconds } from '@paperseal/protocol';

import { draftProgress, draftTitle, type StoredDraft } from './draftStore';
import { decideStep, type Snapshot } from './examState';
import type { KnownExam } from './examsStore';
import { sealStateAt } from './StatusStep';

/*
 * What the board's home list says about each exam and draft. The words come from the same stage
 * logic the exam's own page uses (`decideStep`, `sealStateAt`), so the list can never disagree with it.
 */

export interface ExamStatus {
  label: string;
  /** The board has something to do now, so the row is shown more strongly. */
  needsBoard: boolean;
}

/** One line for an exam, from what was read on the chain and, for the current exam, from Paper Seal. */
export function examStatus(snapshot: Snapshot, nowMs: number): ExamStatus {
  const settings = snapshot.found?.exam.settings;
  const step = decideStep(snapshot);
  if (!settings || step === 'draft') return { label: 'Unpublished', needsBoard: false };
  if (step === 'people') return { label: 'Inviting', needsBoard: true };
  const unlockMs = roundTimeSeconds(Number(settings.unlockRound)) * 1000;
  const endMs = roundTimeSeconds(Number(settings.endRound)) * 1000;
  if (step === 'status') {
    return sealStateAt(nowMs, unlockMs, endMs) === 'open'
      ? { label: 'Finished', needsBoard: false }
      : { label: 'Posted', needsBoard: false };
  }
  // No paper's record is posted. Past the end, none can be, so the exam cannot go ahead.
  if (snapshot.status?.stage === 'failed' || nowMs >= endMs) return { label: 'Failed', needsBoard: false };
  if (step === 'post-build') return { label: 'Ready', needsBoard: true };
  return nowMs >= roundTimeSeconds(Number(settings.lockRound)) * 1000
    ? { label: 'Building', needsBoard: false }
    : { label: 'Collecting', needsBoard: false };
}

/**
 * An exam on the chain whose start has passed with no Build. It can't be deleted from the contract, so
 * the list hides it. Only a read that came back says so: no snapshot, or an exam not found, hides nothing.
 */
export function isAbandoned(snapshot: Snapshot | null, nowMs: number): boolean {
  const settings = snapshot?.found?.exam.settings;
  return Boolean(snapshot && settings && !snapshot.build && nowMs >= Number(settings.examStart) * 1000);
}

export type HomeRow =
  | { kind: 'draft'; key: string; at: number | null; draft: StoredDraft; title: string; progress: string }
  | { kind: 'exam'; key: string; at: number | null; exam: KnownExam; title: string };

/** Drafts and published exams in one list, newest first. Rows with no known time follow, in the order given. */
export function homeRows(drafts: readonly StoredDraft[], exams: readonly KnownExam[]): HomeRow[] {
  const rows: HomeRow[] = [
    ...drafts.map(
      (draft): HomeRow => ({ kind: 'draft', key: `draft-${draft.id}`, at: draft.updatedAt, draft, title: draftTitle(draft), progress: draftProgress(draft) }),
    ),
    ...exams.map((exam): HomeRow => ({ kind: 'exam', key: `exam-${exam.id}`, at: exam.addedAt, exam, title: exam.name ?? 'An exam without a saved name' })),
  ];
  // Array.prototype.sort is stable, so equal and unknown times keep the order they came in.
  return rows.sort((a, b) => (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY));
}
