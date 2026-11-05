import { useCallback, useEffect, useState } from 'react';

export interface Polled<T> {
  /** The latest good value. It is kept through a failed read, so one dropped read does not blank a screen. */
  value: T | null;
  /** Why the latest read failed, or null if it worked. */
  error: string | null;
  /** The first read has come back, good or bad. */
  settled: boolean;
  /** Reads again now. */
  refresh: () => void;
}

interface Latest<T> {
  source: () => Promise<T>;
  value: T | null;
  error: string | null;
}

/**
 * Reads `load` every `ms` after the last read finished, so a slow source is never read twice at
 * once. `load` must be stable, and null reads nothing. Once `finished` says a value can no longer
 * change, polling stops. `finished` must be stable too.
 */
export function usePoll<T>(load: (() => Promise<T>) | null, ms: number, finished?: (value: T) => boolean): Polled<T> {
  const [latest, setLatest] = useState<Latest<T> | null>(null);
  const [nudge, setNudge] = useState(0);

  useEffect(() => {
    if (!load) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      load().then(
        (value) => {
          if (!live) return;
          setLatest({ source: load, value, error: null });
          if (!finished?.(value)) timer = setTimeout(read, ms);
        },
        (error: unknown) => {
          if (!live) return;
          const message = error instanceof Error ? error.message : String(error);
          setLatest((last) => ({ source: load, value: last?.source === load ? last.value : null, error: message }));
          timer = setTimeout(read, ms);
        },
      );
    };
    read();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, ms, finished, nudge]);

  const refresh = useCallback(() => {
    setNudge((n) => n + 1);
  }, []);
  const current = latest?.source === load ? latest : null;
  return { value: current?.value ?? null, error: current?.error ?? null, settled: current !== null, refresh };
}
