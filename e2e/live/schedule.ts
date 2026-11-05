import {
  checkCriteria,
  checkSchedule,
  chain,
  criteriaHash,
  encodeCriteria,
  examIdFromName,
  firstRoundAtOrAfter,
  roundTimeSeconds,
  startupArgs,
  toHex,
  type Criteria,
  type ExamSettings,
  type Hex,
} from '@paperseal/protocol';

import { gaps, rpcHost, deployed } from './config';
import type { Schedule } from './state';

/*
 * Why these gaps: the TEE reads the approved list at Sepolia's `finalized` block, which took about
 * 17 minutes in a real run. So Lock is 28 minutes out, which leaves room to register, post, wait for
 * finality and let the setters submit. Unlock is 3 minutes after Lock, T is 1 minute later and the
 * end round is 4 minutes after that, so delta is 1 minute.
 */

export const liveCriteria: Criteria = {
  maxSetterPercent: 50,
  minBankMultiple: 2,
  topics: [
    { name: 'Mathematics', questions: 3 },
    { name: 'Physics', questions: 3 },
  ],
};

/** Two setters at 50 percent each give 3 per topic, which is the 6 per topic the multiple of 2 needs. */
export const questionsPerSetterPerTopic = 3;

export function computeSchedule(nowSeconds: number): Schedule {
  const examStart = nowSeconds + gaps.examStart;
  const delta = gaps.examStart - gaps.unlock;
  const lockRound = firstRoundAtOrAfter(nowSeconds + gaps.lock);
  const unlockRound = firstRoundAtOrAfter(examStart - delta);
  const endRound = firstRoundAtOrAfter(nowSeconds + gaps.end);
  return {
    createdAtUnix: nowSeconds,
    examStart,
    delta,
    lockRound: String(lockRound),
    unlockRound: String(unlockRound),
    endRound: String(endRound),
    lockAtUnix: roundTimeSeconds(lockRound),
    unlockAtUnix: roundTimeSeconds(unlockRound),
    endAtUnix: roundTimeSeconds(endRound),
  };
}

export function examName(at: Date = new Date()): string {
  return `Paper Seal live ${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

export interface Plan {
  examId: Hex;
  settings: ExamSettings;
  criteriaEncoded: Hex;
  criteriaHash: Hex;
}

/** Builds the settings and runs the same `checkSchedule` the board app runs before `createExam`. */
export function plan(name: string, schedule: Schedule, registry: Hex = deployed.registry): Plan {
  checkCriteria(liveCriteria);
  const encoded = encodeCriteria(liveCriteria);
  const hash = toHex(criteriaHash(encoded));
  const examId = examIdFromName(name);
  const settings: ExamSettings = {
    examId,
    examStart: schedule.examStart,
    delta: schedule.delta,
    lockRound: schedule.lockRound,
    unlockRound: schedule.unlockRound,
    endRound: schedule.endRound,
    criteriaHash: hash,
    rpcHost,
    registry,
    chainId: chain.chainId,
  };
  checkSchedule(settings);
  return { examId, settings, criteriaEncoded: toHex(encoded), criteriaHash: hash };
}

/** The arguments `deploy/gcp/run-tee.sh` takes: the ten startup arguments, then the image digest. */
export function runTeeArgs(settings: ExamSettings, imageDigest: Hex): string[] {
  return [...startupArgs(settings), `--image-digest=sha256:${imageDigest.slice(2)}`];
}
