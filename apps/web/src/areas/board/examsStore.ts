import type { Hex } from '@paperseal/protocol';

import { getStoredExamId } from '../../shared/currentExam';

/*
 * The exams this browser has published, so the board can get back to one. Only the exam's ID and the
 * name typed for it are kept: ExamRegistry stores just the name's hash. An exam published before this
 * list existed is still found, without its name, from the pointer to the current exam and from the
 * invites kept for it.
 */

const KEY = 'paperseal.board.exams';
const INVITES = 'paperseal.invites.';
const isExamId = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);

export interface KnownExam {
  id: Hex;
  /** Null for an exam published before names were kept. */
  name: string | null;
  /** Milliseconds since 1970, when this browser published it. Null for an exam found from older traces. */
  addedAt: number | null;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readStored(): KnownExam[] {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const exams: KnownExam[] = [];
    for (const entry of list as unknown[]) {
      const { id, name, addedAt } = (entry ?? {}) as { id?: unknown; name?: unknown; addedAt?: unknown };
      if (isExamId(id) && !exams.some((exam) => exam.id === id)) {
        exams.push({
          id,
          name: typeof name === 'string' && name !== '' ? name : null,
          addedAt: typeof addedAt === 'number' && Number.isFinite(addedAt) ? addedAt : null,
        });
      }
    }
    return exams;
  } catch {
    return [];
  }
}

/** Called once an exam is published and read back correctly. The newest comes first. */
export function rememberExam(exam: { id: Hex; name: string }, now = Date.now()): void {
  try {
    const id = exam.id.toLowerCase() as Hex;
    storage()?.setItem(KEY, JSON.stringify([{ id, name: exam.name, addedAt: now }, ...readStored().filter((known) => known.id !== id)]));
  } catch {
    // Not stored: the exam is still reachable from the board's current exam.
  }
}

export function listKnownExams(): KnownExam[] {
  const exams = readStored();
  const add = (id: unknown) => {
    if (isExamId(id) && !exams.some((exam) => exam.id === id)) exams.push({ id, name: null, addedAt: null });
  };
  add(getStoredExamId());
  try {
    const store = storage();
    for (let index = 0; store && index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(INVITES)) add(key.slice(INVITES.length));
    }
  } catch {
    // The list stays as far as it got.
  }
  return exams;
}
