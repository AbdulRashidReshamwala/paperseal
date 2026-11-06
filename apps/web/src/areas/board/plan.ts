import type { Criteria } from '@paperseal/protocol';

import { evaluateBlueprint, evaluateSchedule, parseLocalTime, type BlueprintInput, type ScheduleInput, type TopicInput } from './form';

/*
 * What the board types on one page, in plain terms, and how it becomes the BlueprintInput and
 * ScheduleInput that form.ts checks. Nothing here decides whether a value is acceptable: every
 * rule stays in form.ts and @paperseal/protocol.
 */

export interface PlanInput {
  name: string;
  /** Local time, `YYYY-MM-DDTHH:mm` from the date picker. */
  examStart: string;
  durationMinutes: string;
  /** How long before the start the paper is released to centres: Δ, in minutes. */
  releaseMinutes: string;
  topics: TopicInput[];
  maxSetterPercent: string;
  minBankMultiple: string;
  /** When questions close. Empty means `defaultLockSeconds` picks it. */
  lockTime: string;
}

export const defaultPlan: PlanInput = {
  name: '',
  examStart: '',
  durationMinutes: '180',
  releaseMinutes: '10',
  topics: [{ name: '', questions: '' }],
  maxSetterPercent: '20',
  minBankMultiple: '4',
  lockTime: '',
};

export const toBlueprint = (plan: PlanInput): BlueprintInput => ({
  name: plan.name,
  topics: plan.topics,
  maxSetterPercent: plan.maxSetterPercent,
  minBankMultiple: plan.minBankMultiple,
});

const DAY = 86400;

/**
 * Questions close a day before the paper is released, which leaves time for the Build and for
 * centres to download. An exam closer than that closes halfway between now and the release. Lock
 * always stays adjustable, and `checkSchedule` has the last word on it.
 */
export function defaultLockSeconds(unlockSeconds: number, nowSeconds: number): number {
  const dayBefore = unlockSeconds - DAY;
  return dayBefore > nowSeconds ? dayBefore : nowSeconds + Math.floor((unlockSeconds - nowSeconds) / 2);
}

/** Below this, there isn't time to register everyone and have the list go final. See e2e/live/schedule.ts. */
const MIN_ONBOARDING_SECONDS = 30 * 60;

/** Local `YYYY-MM-DD HH:mm`, the shape `parseLocalTime` reads. */
export function toLocalInput(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const minutes = (text: string): number | null => (/^[0-9]+$/.test(text.trim()) ? Number(text.trim()) : null);

export function toSchedule(plan: PlanInput, nowSeconds: number): ScheduleInput {
  const start = parseLocalTime(plan.examStart);
  const duration = minutes(plan.durationMinutes);
  const release = minutes(plan.releaseMinutes);
  const automatic = start !== null && release !== null ? toLocalInput(defaultLockSeconds(start - release * 60, nowSeconds)) : '';
  return {
    examStart: plan.examStart,
    deltaMinutes: plan.releaseMinutes,
    lockTime: plan.lockTime.trim() === '' ? automatic : plan.lockTime,
    endTime: start !== null && duration !== null && duration >= 1 ? toLocalInput(start + duration * 60) : '',
  };
}

/** The plan as form.ts sees it, each part evaluated by @paperseal/protocol. */
export function evaluatePlan(plan: PlanInput, nowSeconds = Math.floor(Date.now() / 1000)) {
  const scheduleInput = toSchedule(plan, nowSeconds);
  return {
    blueprint: evaluateBlueprint(toBlueprint(plan)),
    scheduleInput,
    schedule: evaluateSchedule(scheduleInput, nowSeconds),
    nowSeconds,
  };
}

export const durationError = (text: string): string | null => {
  const value = minutes(text);
  return value === null || value < 1 ? 'Enter a whole number of minutes, at least 1.' : null;
};

export const isTight = (lockSeconds: number, nowSeconds: number): boolean => lockSeconds - nowSeconds < MIN_ONBOARDING_SECONDS;

/** A moment for reading: the day and the time, with no seconds. */
export function formatWhen(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export const formatTimeOnly = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** What the setter limits come to: `checkCriteria` and the TEE enforce them, this only states them. */
export function bankNeeded(criteria: Criteria): { questions: number; setters: number } {
  return {
    questions: criteria.topics.reduce((sum, topic) => sum + topic.questions * criteria.minBankMultiple, 0),
    setters: Math.ceil(100 / criteria.maxSetterPercent),
  };
}

/** A safety net for wording that still names the system's parts. The checks themselves already speak plainly. */
export function plainWords(message: string): string {
  return message
    .replaceAll('on ExamRegistry', 'on the public record')
    .replaceAll('ExamRegistry', 'the public record')
    .replaceAll('on-chain', 'on the public record')
    .replaceAll('the TEE', 'Paper Seal')
    .replaceAll('The TEE', 'Paper Seal')
    .replaceAll('TEE', 'Paper Seal');
}

/** The hostname the wallet's reads already use, which is the operator a board would name. */
export function defaultRpcHost(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
): string {
  try {
    return env.VITE_RPC_URL ? new URL(env.VITE_RPC_URL).hostname : '';
  } catch {
    return '';
  }
}

/**
 * The public verifier is a separate app, hosted on its own, so its address is configuration. With an
 * exam ID it is the share link from spec/agent-verification.md, `<verifier URL>/?exam=<examId>`,
 * which names the exam in the part of the address a server sees, so it also works for an agent.
 */
export function verifierUrl(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
  examId?: string | null,
): string | null {
  const given = env.VITE_VERIFIER_URL?.trim();
  if (!given) return null;
  try {
    const url = new URL(given);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!examId) return given;
    url.hash = '';
    url.searchParams.set('exam', examId.toLowerCase());
    return url.toString();
  } catch {
    return null;
  }
}

export type DraftStep = 'create' | 'review';

/** The exam has to be complete to be reviewed, so a value that stops being valid sends the board back to it. */
export function draftScreen(chosen: DraftStep, ready: { create: boolean }): DraftStep {
  return !ready.create || chosen === 'create' ? 'create' : 'review';
}
