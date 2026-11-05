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

import { gaps, rpcHost, deployed, type LiveGaps } from './config';
import type { Schedule } from './state';

/*
 * Why these gaps. `chain.readBlock` says which block the TEE reads the approved list at, and gapsFor
 * in config.ts holds both sets.
 *
 * `finalized`: Sepolia's finalized block took about 17 minutes in a real run. So Lock is 28 minutes
 * out, which leaves room to register, post, wait for finality and let the setters submit. Unlock is
 * 3 minutes after Lock, T is 1 minute later and the end round is 4 minutes after that, so delta is
 * 1 minute.
 *
 * `latest`: the TEE sees the list as soon as it is mined, so a whole exam fits in under 5 minutes.
 * Lock is at 3:30, unlock 30 seconds later, T 15 seconds after that, so delta is 15 seconds, and the
 * end round is at 4:45. That leaves 45 seconds for all 8 shares, which took 31 seconds in a real run,
 * because the TEE refuses a share once the end round is out.
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

export function computeSchedule(nowSeconds: number, using: LiveGaps = gaps): Schedule {
  const examStart = nowSeconds + using.examStart;
  const delta = using.examStart - using.unlock;
  const lockRound = firstRoundAtOrAfter(nowSeconds + using.lock);
  const unlockRound = firstRoundAtOrAfter(examStart - delta);
  const endRound = firstRoundAtOrAfter(nowSeconds + using.end);
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
