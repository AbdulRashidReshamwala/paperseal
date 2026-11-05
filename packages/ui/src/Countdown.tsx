import { useEffect, useState, type ReactNode } from 'react';

/** Whole seconds left as `2:03:04`, with days in front once there is at least one. */
export function formatRemaining(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const [days, hours, minutes, seconds] = [
    Math.floor(total / 86400),
    Math.floor((total % 86400) / 3600),
    Math.floor((total % 3600) / 60),
    total % 60,
  ];
  const clock = `${String(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${String(days)}d ${clock}` : clock;
}

function useNowMs(now: () => number, stopAt: number): number {
  const [ms, setMs] = useState(now);
  useEffect(() => {
    if (ms >= stopAt) return;
    const id = setInterval(() => {
      setMs(now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [now, stopAt, ms]);
  return ms;
}

const defaultNow = () => Date.now();

/**
 * Counts down to a moment that has both a clock time and a public clock (drand) round. The round
 * is what really opens the seal, so it is shown, in plain words; the time is for reading. This
 * only displays: pass `at` from the round's scheduled time, and let the round decide the flow.
 */
export function Countdown(props: {
  /** The moment, in milliseconds since the epoch. */
  at: number;
  /** The drand round due at that moment. */
  round: number;
  /** What the moment is, such as "Paper unlocks". */
  label?: string;
  /** Shown in place of the clock once the moment has passed. */
  reached?: ReactNode;
  /** For tests. */
  now?: () => number;
  locale?: string;
  timeZone?: string;
}) {
  const { at, round, label = 'Opens', locale, timeZone } = props;
  const ms = useNowMs(props.now ?? defaultNow, at);
  const remaining = Math.ceil((at - ms) / 1000);
  const when = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
  return (
    <div className="ps-countdown" data-reached={remaining <= 0 ? 'true' : undefined}>
      <p className="ps-eyebrow">{label}</p>
      <p className="ps-countdown-clock" role="timer" aria-live="off">
        {remaining > 0 ? formatRemaining(remaining) : (props.reached ?? 'Now')}
      </p>
      <p className="ps-countdown-when">
        <span>{when}</span>
        <span>Public clock round {round.toLocaleString(locale)}</span>
      </p>
    </div>
  );
}
