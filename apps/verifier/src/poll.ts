import { withinTime } from '@paperseal/verify';
import { useEffect, useRef, useState } from 'react';

export type Polled<T> =
  /** The source is not configured. */
  | { state: 'off' }
  | { state: 'loading' }
  /** `stale` holds why the latest read failed. `value` is then the last good read, from `readAt`. */
  | { state: 'ready'; value: T; readAt: number; stale?: string }
  | { state: 'error'; message: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A read that never answers must not leave a section on "Reading". It counts as failed, and is tried again. */
export const READ_TIMEOUT_MS = 30_000;

/** The longest wait after failed reads of a source that has answered before. Its last read still shows. */
export const MAX_BACKOFF_MS = 5 * 60_000;

/** The first wait after a failed read of a source that has not answered yet, while the page shows nothing from it. */
export const FIRST_RETRY_MS = 3000;

/** The longest wait after failed reads of a source that has not answered yet. */
export const MAX_RETRY_MS = 30_000;

/** Longer than any read gets from its own limit. A read that never ends must not end the polling. */
export const READ_GIVE_UP_MS = 90_000;

/**
 * How long to wait before the next read, after `failures` failed reads in a row. With nothing to show
 * it is 3, 6, 12 and 24 seconds, then 30. With a last good read it doubles `everyMs`, up to
 * `MAX_BACKOFF_MS` or `everyMs` if that is longer, so a source that is limiting this page gets room.
 */
export function nextReadMs(everyMs: number, failures: number, hasRead: boolean): number {
  if (failures === 0) return everyMs;
  if (hasRead) return Math.min(everyMs * 2 ** failures, Math.max(everyMs, MAX_BACKOFF_MS));
  return Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
}

/**
 * Keeps the answers to a group of reads, so that trying again asks only for those that failed. A read
 * still under way is shared, not sent twice. `forget` drops them all, for a new read of the whole group.
 */
export function keepAnswers() {
  const kept = new Map<string, Promise<unknown>>();
  return {
    read<T>(key: string, load: () => Promise<T>): Promise<T> {
      const held = kept.get(key) as Promise<T> | undefined;
      if (held) return held;
      const reading = load();
      kept.set(key, reading);
      reading.catch(() => {
        kept.delete(key);
      });
      return reading;
    },
    forget() {
      kept.clear();
    },
  };
}

/**
 * Reads `load` now and again `everyMs` after each read finishes, so a slow source is never read
 * twice at once. Pass a stable function, and a new one to start over: nothing read from the old
 * source is ever shown for the new one. A null `everyMs` reads once per `load`. After a failed read
 * the wait comes from `nextReadMs`, and a read that answers goes back to `everyMs`.
 */
export function usePoll<T>(load: (() => Promise<T>) | null, everyMs: number | null): Polled<T> {
  const [seen, setSeen] = useState<{ source: () => Promise<T>; polled: Polled<T> } | null>(null);
  // Outlives a change of `everyMs`, which starts the timer over but not what has been read.
  const answered = useRef<(() => Promise<T>) | null>(null);

  useEffect(() => {
    if (!load) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const read = () => {
      withinTime(load(), READ_GIVE_UP_MS, 'The read took too long to answer.')
        .then(
          (value) => {
            failures = 0;
            answered.current = load;
            if (live) setSeen({ source: load, polled: { state: 'ready', value, readAt: Date.now() } });
          },
          (error: unknown) => {
            failures += 1;
            if (!live) return;
            setSeen((old) =>
              old?.source === load && old.polled.state === 'ready'
                ? { source: load, polled: { ...old.polled, stale: message(error) } }
                : { source: load, polled: { state: 'error', message: message(error) } },
            );
          },
        )
        .finally(() => {
          if (live && everyMs !== null) timer = setTimeout(read, nextReadMs(everyMs, failures, answered.current === load));
        });
    };
    read();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, everyMs]);

  if (!load) return { state: 'off' };
  return seen?.source === load ? seen.polled : { state: 'loading' };
}
