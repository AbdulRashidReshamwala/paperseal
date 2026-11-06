import {
  checkCriteria,
  checkSchedule,
  chain,
  criteriaHash,
  encodeCriteria,
  examIdFromName,
  examNameProblem,
  firstRoundAtOrAfter,
  roundTimeSeconds,
  startupArgs,
  toHex,
  type Criteria,
  type ExamSettings,
  type Hex,
  type Question,
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
 * Lock is at 2:45, unlock 30 seconds later, T 15 seconds after that, so delta is 15 seconds, and the
 * end round is at 4:55. That leaves 100 seconds for the download and all 8 shares, because the TEE
 * refuses a share once the end round is out, and a real run spent 36 seconds downloading and 31 on shares.
 */

/**
 * The text of one question. It is numbered per topic across all setters, so no two questions read the
 * same, and it carries nothing about who wrote it: a paper must never show a setter's identity.
 */
export function questionText(topic: string, numberInTopic: number): string {
  return `${topic} question ${String(numberInTopic)}: explain a result and show the working.`;
}

/**
 * One question of the live paper. Every third question in a topic is multiple choice, so a run covers
 * both kinds: the third has four options and the sixth has two, which are the longer and shorter
 * lists the form allows. Options are distinct and name no one. No answer key is part of a question.
 */
export function liveQuestion(topic: string, numberInTopic: number): Question {
  const text = questionText(topic, numberInTopic);
  if (numberInTopic % 3 !== 0) return { topic, text };
  const options =
    numberInTopic % 2 === 1
      ? ['The result follows directly', 'The result needs a further assumption', 'The result is false', 'The question is ill-posed']
      : ['True', 'False'];
  return { topic, text, options };
}

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

/** The default exam name: one normalised ENS label (spec/api.md "Exam Names"), like `paperseal-live-20261106t120000z`. */
export function examName(at: Date = new Date()): string {
  const name = `paperseal-live-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').toLowerCase()}`;
  const problem = examNameProblem(name);
  if (problem) throw new Error(`the default exam name ${name} is invalid: ${problem}`);
  return name;
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
