import type { MirrorTarget } from './args';
import { errorText } from './output';
import { mirrorPass, newMemo, type PassDeps, type PassReport } from './mirror';

/*
 * `watch`: the mirror pass on a loop. Each pass reads the TEE's status before its log, so when
 * the status says released or failed, that pass already saw the final log, and the loop stops.
 * A TEE that shows another exam, or no exam, never stops it. Errors from a source are notes in
 * the report; anything else thrown is printed and the loop goes on.
 */

export type WatchEnd = 'released' | 'failed' | 'stopped';

export interface WatchDeps extends PassDeps {
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  onReport: (report: PassReport) => void;
  onError: (message: string) => void;
  /** Passes to retry after a terminal stage while writes keep failing. */
  finalRetries?: number;
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

export async function watch(target: MirrorTarget, everySeconds: number, deps: WatchDeps): Promise<WatchEnd> {
  const memo = newMemo();
  const finalRetries = deps.finalRetries ?? 3;
  let terminalPasses = 0;
  while (!deps.signal.aborted) {
    let report: PassReport | undefined;
    try {
      report = await mirrorPass(target, deps, memo);
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
    await deps.sleep(everySeconds * 1000, deps.signal);
  }
  return 'stopped';
}
