import { useEffect, useState } from 'react';

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

/** The longest wait after failed reads. A source that is limiting this page gets room to recover. */
export const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Reads `load` now and again `everyMs` after each read finishes, so a slow source is never read
 * twice at once. Pass a stable function, and a new one to start over: nothing read from the old
 * source is ever shown for the new one. A null `everyMs` reads once per `load`. Each failed read in
 * a row doubles the wait, up to `MAX_BACKOFF_MS`, so a public source that is limiting requests is not
 * asked harder.
 */
export function usePoll<T>(load: (() => Promise<T>) | null, everyMs: number | null): Polled<T> {
  const [seen, setSeen] = useState<{ source: () => Promise<T>; polled: Polled<T> } | null>(null);

  useEffect(() => {
    if (!load) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const read = () => {
      load()
        .then(
          (value) => {
            failures = 0;
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
          if (live && everyMs !== null) timer = setTimeout(read, Math.min(everyMs * 2 ** failures, Math.max(everyMs, MAX_BACKOFF_MS)));
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
