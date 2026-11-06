import type { Criteria, Hex, Stage } from '@paperseal/protocol';

import { compareWithBuild, type StoredReceipt } from './receipts';

/*
 * What the page shows, worked out from the exam's state. Everything here only presents: sealing
 * itself is gated by `Confirmed` in submit.ts, whatever this file says.
 */

export type SetterScreen = 'not-set-up' | 'opening' | 'unreachable' | 'not-open' | 'register' | 'waiting' | 'write' | 'closed';

export function setterScreen(input: {
  configured: boolean;
  stage: Stage | null;
  statusFailed: boolean;
  registered: boolean;
  /** A posted Build proves the bank closed, even once the TEE has gone away. */
  buildPosted: boolean;
  /** The sealed machine is on another exam, so its stage says nothing about this one. */
  elsewhere?: boolean;
}): SetterScreen {
  const { stage, registered } = input;
  if (!input.configured) return 'not-set-up';
  if (input.buildPosted) return 'closed';
  if (input.elsewhere) return registered ? 'waiting' : 'not-open';
  if (stage === null) return input.statusFailed ? 'unreachable' : 'opening';
  if (stage === 'publish') return registered ? 'waiting' : 'not-open';
  if (stage === 'onboard') return registered ? 'waiting' : 'register';
  if (stage === 'submit') return registered ? 'write' : 'register';
  return 'closed';
}

const topicsKey = (examId: Hex) => `paperseal.topics.${examId.toLowerCase()}`;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Which topic each sealed question was for, by question hash, read back for the progress shown. */
export function loadTopics(examId: Hex): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(topicsKey(examId)) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, topic]) => typeof topic === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** A receipt doesn't record its topic, so this browser notes it alongside. Never the question text. */
export function saveTopic(examId: Hex, questionHash: Hex, topic: string): void {
  try {
    storage()?.setItem(topicsKey(examId), JSON.stringify({ ...loadTopics(examId), [questionHash]: topic }));
  } catch {
    // Only the progress figures lose out. The receipt is already kept.
  }
}

export interface TopicProgress {
  name: string;
  /** Sealed from this browser for this topic, counting only receipts that verified. */
  sealed: number;
  /** The smallest bank the exam accepts for this topic, across all setters. */
  needed: number;
}

export function topicProgress(criteria: Criteria, sealedHashes: readonly string[], topics: Record<string, string>): TopicProgress[] {
  return criteria.topics.map(({ name, questions }) => ({
    name,
    sealed: sealedHashes.filter((hash) => topics[hash] === name).length,
    needed: questions * criteria.minBankMultiple,
  }));
}

/** The topic furthest from its minimum, to start on. */
export function nextTopic(progress: readonly TopicProgress[]): string {
  const ratio = (topic: TopicProgress) => topic.sealed / topic.needed;
  return progress.reduce<TopicProgress | null>((best, topic) => (best && ratio(best) <= ratio(topic) ? best : topic), null)?.name ?? '';
}

export type BuildRead =
  | { state: 'unread' }
  | { state: 'not-posted' }
  | { state: 'posted'; key: Hex }
  | { state: 'failed' };

/** True, false or not yet known, by question hash. */
export type ReceiptChecks = Record<string, boolean>;

export type ClosedCheck =
  /** Nothing was sealed from this browser, so there is nothing to check. */
  | { status: 'none' }
  | { status: 'pass' }
  | { status: 'pending' }
  | { status: 'not-checked' }
  | { status: 'fail'; cause: 'bad-receipt' | 'different-machine'; affected: StoredReceipt[] };

/**
 * The closed screen's one Check. It passes only once every receipt's signature verified and every
 * receipt names the key that signed the Build. Anything unknown stays short of a pass.
 */
export function closedCheck(input: {
  receipts: readonly StoredReceipt[];
  checks: ReceiptChecks;
  /** False without this browser's key, which the signature check needs. */
  canVerify: boolean;
  build: BuildRead;
}): ClosedCheck {
  const { receipts, checks, canVerify, build } = input;
  if (receipts.length === 0) return { status: 'none' };
  if (build.state === 'posted') {
    const affected = compareWithBuild(receipts, build.key)
      .filter(({ match }) => match === 'mismatch')
      .map(({ receipt }) => receipt);
    if (affected.length > 0) return { status: 'fail', cause: 'different-machine', affected };
  }
  const invalid = receipts.filter((receipt) => checks[receipt.questionHash] === false);
  if (invalid.length > 0) return { status: 'fail', cause: 'bad-receipt', affected: invalid };
  if (!canVerify || build.state === 'failed') return { status: 'not-checked' };
  if (build.state !== 'posted') return { status: 'pending' };
  return receipts.every((receipt) => checks[receipt.questionHash] === true) ? { status: 'pass' } : { status: 'pending' };
}
