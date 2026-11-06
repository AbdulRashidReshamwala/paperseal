import { useEffect, useState } from 'react';

export type Polled<T> =
  /** The source is not configured. */
  | { state: 'off' }
  | { state: 'loading' }
  /** `stale` holds why the latest read failed. `value` is then the last good read, from `readAt`. */
  | { state: 'ready'; value: T; readAt: number; stale?: string }
  | { state: 'error'; message: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Reads `load` now and again `everyMs` after each read finishes, so a slow source is never read
 * twice at once. Pass a stable function, and a new one to start over: nothing read from the old
 * source is ever shown for the new one. A null `everyMs` reads once per `load`.
 */
export function usePoll<T>(load: (() => Promise<T>) | null, everyMs: number | null): Polled<T> {
  const [seen, setSeen] = useState<{ source: () => Promise<T>; polled: Polled<T> } | null>(null);

  useEffect(() => {
    if (!load) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      load()
        .then(
          (value) => {
            if (live) setSeen({ source: load, polled: { state: 'ready', value, readAt: Date.now() } });
          },
          (error: unknown) => {
            if (!live) return;
            setSeen((old) =>
              old?.source === load && old.polled.state === 'ready'
                ? { source: load, polled: { ...old.polled, stale: message(error) } }
                : { source: load, polled: { state: 'error', message: message(error) } },
            );
          },
        )
        .finally(() => {
          if (live && everyMs !== null) timer = setTimeout(read, everyMs);
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
