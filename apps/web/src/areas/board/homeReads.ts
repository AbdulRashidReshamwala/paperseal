import type { Hex } from '@paperseal/protocol';
import { useEffect, useRef, useState } from 'react';

import type { Snapshot } from './examState';

/** What the home list knows about one exam. A row with no entry is still being read. */
export type RowRead = { state: 'ready'; snapshot: Snapshot } | { state: 'failed' };

/** How many exams are read at once. */
export const HOME_READ_LIMIT = 3;

/**
 * Reads each exam in `ids` with at most `limit` reads at once, one failing read never stopping the
 * rest, then reads them all again `ms` after the last one finishes. A failed read keeps the row's
 * last good value, so a blip never replaces a status with a complaint. `load` is given that last
 * value, so what ExamRegistry never changes is not read again.
 */
export function useRowReads(
  ids: readonly Hex[],
  load: ((id: Hex, previous: Snapshot | null) => Promise<Snapshot>) | null,
  ms: number,
  limit = HOME_READ_LIMIT,
): ReadonlyMap<Hex, RowRead> {
  const [reads, setReads] = useState<ReadonlyMap<Hex, RowRead>>(new Map());
  const key = ids.join(',');
  const last = useRef(new Map<Hex, Snapshot>());

  useEffect(() => {
    if (!load || key === '') return;
    const wanted = key.split(',') as Hex[];
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readOne = async (id: Hex) => {
      try {
        const snapshot = await load(id, last.current.get(id) ?? null);
        last.current.set(id, snapshot);
        if (live) setReads((previous) => new Map(previous).set(id, { state: 'ready', snapshot }));
      } catch {
        const kept = last.current.get(id);
        if (live) setReads((previous) => new Map(previous).set(id, kept ? { state: 'ready', snapshot: kept } : { state: 'failed' }));
      }
    };
    const pass = async () => {
      const queue = [...wanted];
      const worker = async () => {
        for (let id = queue.shift(); id !== undefined && live; id = queue.shift()) await readOne(id);
      };
      await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
      if (live) timer = setTimeout(() => void pass(), ms);
    };
    void pass();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, load, ms, limit]);

  return reads;
}
