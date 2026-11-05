import { existsSync, readFileSync } from 'node:fs';

import type { Criteria, DecimalString, Hex } from '@paperseal/protocol';

import { reportPath, statePath } from './config';
import { errorText, stamp, writeJsonAtomic } from './util';

/* The state file holds only public values and hashes. No key, password or share is ever stored. */

export interface Schedule {
  createdAtUnix: number;
  examStart: number;
  delta: number;
  lockRound: DecimalString;
  unlockRound: DecimalString;
  endRound: DecimalString;
  /** Unix seconds each round is produced. */
  lockAtUnix: number;
  unlockAtUnix: number;
  endAtUnix: number;
}

export interface PublishedExam {
  name: string;
  examId: Hex;
  publishedAt: string;
  release: { version: string; commit: Hex; imageDigest: Hex; run: string; repo: string };
  schedule: Schedule;
  criteria: Criteria;
  criteriaEncoded: Hex;
  criteriaHash: Hex;
  rpcHost: string;
  registry: Hex;
  chainId: number;
  transactionHash: Hex;
  blockNumber: string;
  /** The `deploy/gcp/run-tee.sh` arguments, one per element. */
  runTeeArgs: string[];
}

export interface ParticipantRecord {
  name: string;
  kind: 'setter' | 'neutral' | 'centre-holder' | 'centre';
  role: number;
  /** For a setter, the `owner` on the approved list is the `setterOwner` hash of its passkey, never a name. */
  owner: string;
  passkeyPublicKey: Hex;
  derivedPublicKey: Hex;
}

export interface RunState {
  pid: number;
  startedAt: string;
  updatedAt: string;
  phase: string;
  status: 'running' | 'passed' | 'failed' | 'interrupted';
  finishedAt?: string;
  stopReason?: string;
  participants: ParticipantRecord[];
  approvedList?: { hash: Hex; transactionHash: Hex; blockNumber: string; seenByTeeAt?: string };
  receipts: { setter: string; questionHash: Hex; instancePublicKey: Hex }[];
  build?: { transactionHash: Hex; instancePublicKey: Hex; saltedPaperHash: Hex; storageManifestHash: Hex; paperHash: Hex };
  released: { name: string; passkeyPublicKey: Hex }[];
  paperSha256?: Hex;
}

export interface LiveState {
  version: 1;
  exam?: PublishedExam;
  run?: RunState;
}

export function loadState(): LiveState {
  if (!existsSync(statePath)) return { version: 1 };
  return JSON.parse(readFileSync(statePath, 'utf8')) as LiveState;
}

export function saveState(state: LiveState): void {
  writeJsonAtomic(statePath, state);
}

export function updateRun(mutate: (run: RunState) => void): void {
  const state = loadState();
  if (!state.run) throw new Error('no run in the state file');
  mutate(state.run);
  state.run.updatedAt = stamp();
  saveState(state);
}

/* ------------------------------------------------------------------- Report */

export interface ReportEntry {
  ts: string;
  step: string;
  label: string;
  result: 'Pass' | 'Fail';
  detail: string;
}

/** Thrown after a step that recorded a Fail, so the run stops there. */
export class RunStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStopped';
  }
}

export class Reporter {
  readonly entries: ReportEntry[] = [];
  private readonly startedAt = stamp();
  private readonly meta: { examName: string; examId: Hex };

  constructor(meta: { examName: string; examId: Hex }) {
    this.meta = meta;
    this.flush();
  }

  private flush(): void {
    const fail = this.entries.filter((e) => e.result === 'Fail').length;
    writeJsonAtomic(reportPath, {
      ...this.meta,
      startedAt: this.startedAt,
      updatedAt: stamp(),
      summary: { pass: this.entries.length - fail, fail },
      entries: this.entries,
    });
  }

  /** Plain progress line, not an assertion. */
  note(message: string): void {
    console.log(`${stamp()}  ....  ${message}`);
  }

  record(step: string, label: string, result: 'Pass' | 'Fail', detail: string): boolean {
    const entry: ReportEntry = { ts: stamp(), step, label, result, detail };
    this.entries.push(entry);
    console.log(`${entry.ts}  ${result === 'Pass' ? 'PASS' : 'FAIL'}  [${step}] ${label}${detail ? `: ${detail}` : ''}`);
    this.flush();
    return result === 'Pass';
  }

  /** Runs one assertion. A throw is a Fail with the error's text. Never retries: that is for transient errors inside `run`. */
  async check(step: string, label: string, run: () => Promise<string | void> | string | void): Promise<boolean> {
    try {
      const detail = await run();
      return this.record(step, label, 'Pass', detail ?? '');
    } catch (error) {
      return this.record(step, label, 'Fail', errorText(error));
    }
  }

  /** A step: afterwards, any Fail inside it stops the run. */
  async step<T>(name: string, run: () => Promise<T>): Promise<T> {
    const before = this.entries.filter((e) => e.step === name && e.result === 'Fail').length;
    this.note(`step ${name} begins`);
    const value = await run();
    const after = this.entries.filter((e) => e.step === name && e.result === 'Fail').length;
    if (after > before) throw new RunStopped(`step ${name} recorded ${String(after - before)} failed assertion(s)`);
    return value;
  }
}
