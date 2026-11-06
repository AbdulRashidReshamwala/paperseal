import type { HeartbeatInput } from '@paperseal/arkiv';
import type { Hash, Hex } from 'viem';

import type { MirrorTarget } from './args';
import { errorText } from './output';
import { mirrorPass, newMemo, type PassDeps, type PassReport } from './mirror';

/*
 * `watch`: the mirror pass on a loop. Each pass reads the TEE's status before its log, so when
 * the status says released or failed, that pass already saw the final log, and the loop stops.
 * A TEE that shows another exam, or no exam, never stops it. Errors from a source are notes in
 * the report; anything else thrown is printed and the loop goes on.
 *
 * Beside the passes, on its own timer, `watch` writes a heartbeat every `heartbeatSeconds`, as
 * spec/arkiv.md "Writers" asks, whether or not the log changed. The first is written right after
 * the first pass, so it already carries what that pass saw (none if that pass already ended the
 * watch: unlock is over), and they stop when the loop does. A failed heartbeat is printed and tried again at the next tick; it never stops the loop.
 */

export type WatchEnd = 'released' | 'failed' | 'stopped';

/** A heartbeat that was written, and what it said. */
export interface Beat {
  at: Date;
  entriesHash: string | null;
  stage: string | null;
  entityKey: Hex;
  txHash: Hash;
}

export interface HeartbeatDeps {
  /** `arkiv.heartbeatSeconds` in spec/arkiv.json. */
  seconds: number;
  /** `createArkivWriter(...).heartbeat`: writes one heartbeat, every time. */
  write: (input: HeartbeatInput) => Promise<{ entityKey: Hex; txHash: Hash }>;
  onWritten: (beat: Beat) => void;
}

export interface WatchDeps extends PassDeps {
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  onReport: (report: PassReport) => void;
  onError: (message: string) => void;
  /** Passes to retry after a terminal stage while writes keep failing. */
  finalRetries?: number;
  /** Absent: no heartbeats (`--no-heartbeat`). */
  heartbeat?: HeartbeatDeps | undefined;
}

export const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/** What the next heartbeat says: the newest log this run has seen, and the stage of a TEE serving this exam. */
interface Seen {
  entriesHash: string | null;
  entries: number;
  stage: string | null;
}

/** Logs only grow, so the newest is the one with the most entries. */
export function noteSeen(seen: Seen, report: PassReport): void {
  for (const log of report.logs) {
    if (log.entries >= seen.entries) {
      seen.entries = log.entries;
      seen.entriesHash = log.entriesHash;
    }
  }
  // A TEE that answered but shows another exam, or none, has no stage for this exam. One that
  // didn't answer this pass leaves the last stage read.
  if (report.tee.servesExam === true && report.tee.stage !== undefined) seen.stage = report.tee.stage;
  else if (report.tee.stage !== undefined) seen.stage = null;
}

async function heartbeats(target: MirrorTarget, deps: WatchDeps, beat: HeartbeatDeps, seen: Seen, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const said = { entriesHash: seen.entriesHash, stage: seen.stage };
    try {
      const written = await beat.write({ examId: target.examId, registry: target.registry, chainId: deps.chainId, ...said });
      beat.onWritten({ at: new Date(), ...said, ...written });
    } catch (error) {
      deps.onError(`heartbeat failed, trying again in ${String(beat.seconds)}s: ${errorText(error)}`);
    }
    if (signal.aborted) break;
    await deps.sleep(beat.seconds * 1000, signal);
  }
}

export async function watch(target: MirrorTarget, everySeconds: number, deps: WatchDeps): Promise<WatchEnd> {
  const memo = newMemo();
  const finalRetries = deps.finalRetries ?? 3;
  const seen: Seen = { entriesHash: null, entries: -1, stage: null };
  const beats = new AbortController();
  const stopBeats = () => {
    beats.abort();
  };
  deps.signal.addEventListener('abort', stopBeats, { once: true });
  let beating: Promise<void> | undefined;
  let terminalPasses = 0;
  try {
    while (!deps.signal.aborted) {
      let report: PassReport | undefined;
      try {
        report = await mirrorPass(target, deps, memo);
        noteSeen(seen, report);
        deps.onReport(report);
      } catch (error) {
        deps.onError(`pass failed: ${errorText(error)}`);
      }
      const stage = report?.tee.stage;
      if (report && report.tee.servesExam === true && (stage === 'released' || stage === 'failed')) {
        const clean = !report.outcomes.some((outcome) => outcome.result === 'failed');
        terminalPasses += 1;
        if (clean || terminalPasses > finalRetries) return stage;
        deps.onError(`the TEE says ${stage} but a write failed; trying again (${String(terminalPasses)}/${String(finalRetries)})`);
      }
      if (deps.signal.aborted) break;
      if (deps.heartbeat && !beating) beating = heartbeats(target, deps, deps.heartbeat, seen, beats.signal);
      await deps.sleep(everySeconds * 1000, deps.signal);
    }
    return 'stopped';
  } finally {
    beats.abort();
    deps.signal.removeEventListener('abort', stopBeats);
    await beating;
  }
}
