import type { ChainClient } from '@paperseal/crypto';
import { roundTimeSeconds } from '@paperseal/protocol';
import { useEffect, useState } from 'react';

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Unix seconds, ticking every second. */
export function useNow(): number {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(nowSeconds());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

export interface LatestRound {
  /** The latest round drand has published, or null until it answers. */
  round: number | null;
  error: string | null;
}

/** The latest quicknet round, from drand, checked against the pinned chain by the client. */
export function useLatestRound(client: ChainClient, everyMs = 3000): LatestRound {
  const [state, setState] = useState<LatestRound>({ round: null, error: null });
  useEffect(() => {
    let live = true;
    const poll = () => {
      client.latest().then(
        (beacon) => {
          if (live) setState({ round: beacon.round, error: null });
        },
        (error: unknown) => {
          if (live) setState((old) => ({ round: old.round, error: error instanceof Error ? error.message : String(error) }));
        },
      );
    };
    poll();
    const timer = setInterval(poll, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, everyMs]);
  return state;
}

/**
 * Time left until a round is published. drand's own latest round decides when it is published.
 * The countdown runs on this device's clock, and says so if drand has not answered.
 */
export function roundStatus(round: number, latest: number | null, now: number) {
  if (latest !== null && latest >= round) return { published: true as const };
  return { published: false as const, remaining: roundTimeSeconds(round) - now, drandKnown: latest !== null };
}
