import type { Hex } from '@paperseal/protocol';
import { useMemo, useSyncExternalStore } from 'react';

import type { ExamRegistry } from '@paperseal/chain';

import { envExamId, registry } from './registry';

/*
 * The one exam every area uses: Register, the key holder, centre and setter screens, release and
 * the board. It starts as VITE_EXAM_ID, and publishing an exam replaces it, so a new exam shows
 * without a rebuild. The choice is only a pointer, kept in this browser's localStorage. All exam
 * data is read from ExamRegistry.
 */

const storageKey = 'paperseal.examId';
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readStored(): Hex | null {
  const value = storage()?.getItem(storageKey) ?? null;
  return value && /^0x[0-9a-f]{64}$/.test(value) ? (value as Hex) : null;
}

/** Only an exam this browser was pointed at, never the build's `VITE_EXAM_ID`. */
export const getStoredExamId = readStored;

export function getCurrentExamId(): Hex | null {
  return readStored() ?? envExamId;
}

export function setCurrentExamId(id: Hex): void {
  storage()?.setItem(storageKey, id.toLowerCase());
  listeners.forEach((listener) => {
    listener();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCurrentExamId(): Hex | null {
  return useSyncExternalStore(subscribe, getCurrentExamId, () => envExamId);
}

/** Like `fromExam`, but follows the current exam: a new load function per exam ID. */
export function useExamLoader<T>(
  read: (client: ExamRegistry, id: Hex) => Promise<T>,
  client: ExamRegistry | null = registry,
): (() => Promise<T>) | null {
  const id = useCurrentExamId();
  return useMemo(() => (client && id ? () => read(client, id) : null), [client, id, read]);
}
