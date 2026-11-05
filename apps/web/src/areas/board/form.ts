import {
  chain,
  checkCriteria,
  checkSchedule,
  criteriaHash,
  CriteriaError,
  encodeCriteria,
  examIdFromName,
  firstRoundAtOrAfter,
  fromHex,
  roundTimeSeconds,
  ScheduleError,
  selectedCount,
  toHex,
  type Criteria,
  type Hex,
  type Topic,
} from '@paperseal/protocol';

import type { TeeRelease } from '../../shared/teeReleases';

/** A release whose commit was checked against its tag on GitHub. */
type VerifiedRelease = TeeRelease;

/*
 * Pure logic for the Blueprint, Schedule and Publish screens. Every rule comes
 * from @paperseal/protocol, so what the board sees here is what ExamRegistry
 * and the TEE will accept.
 */

/* ---------------------------------------------------------------- Blueprint */

export interface TopicInput {
  name: string;
  questions: string;
}

export interface BlueprintInput {
  name: string;
  topics: TopicInput[];
  maxSetterPercent: string;
  minBankMultiple: string;
}

export const emptyBlueprint: BlueprintInput = {
  name: '',
  topics: [{ name: '', questions: '' }],
  maxSetterPercent: '',
  minBankMultiple: '',
};

export interface BlueprintResult {
  /** Set only when the name is usable. */
  examId: Hex | null;
  nameError: string | null;
  /** The first rule broken, or null. */
  criteriaError: string | null;
  /** Per-topic field errors, for the rows. */
  topicErrors: { name: string | null; questions: string | null }[];
  percentError: string | null;
  multipleError: string | null;
  /** Null until the criteria are valid. */
  criteria: Criteria | null;
  encoded: Hex | null;
  criteriaHash: Hex | null;
  selectedCount: number | null;
}

const wholeNumber = /^[0-9]+$/;

function parseUint(text: string, label: string): { value: number } | { error: string } {
  if (text.trim() === '') return { error: `${label} is required.` };
  if (!wholeNumber.test(text.trim())) return { error: `${label} must be a whole number.` };
  const value = Number(text.trim());
  if (!Number.isSafeInteger(value)) return { error: `${label} is too large.` };
  return { value };
}

export function evaluateBlueprint(input: BlueprintInput): BlueprintResult {
  let nameError: string | null = null;
  if (input.name === '') nameError = 'Name the exam.';
  else if (input.name !== input.name.trim()) {
    nameError = 'The name must not start or end with a space, because the exam ID hashes it exactly.';
  }
  const examId = nameError === null ? examIdFromName(input.name) : null;

  const percent = parseUint(input.maxSetterPercent, 'Max setter percent');
  const multiple = parseUint(input.minBankMultiple, 'Min bank multiple');
  let percentError = 'error' in percent ? percent.error : null;
  if ('value' in percent && (percent.value < 1 || percent.value > 100)) {
    percentError = 'Max setter percent must be from 1 to 100.';
  }
  let multipleError = 'error' in multiple ? multiple.error : null;
  if ('value' in multiple && multiple.value < 2) multipleError = 'Min bank multiple must be at least 2.';

  const topics: Topic[] = [];
  const seen = new Set<string>();
  const topicErrors = input.topics.map((topic) => {
    const row = { name: null as string | null, questions: null as string | null };
    if (topic.name === '') row.name = 'Topic name is required.';
    else if (seen.has(topic.name)) row.name = 'Topic names must be unique.';
    seen.add(topic.name);
    const questions = parseUint(topic.questions, 'Questions');
    if ('error' in questions) row.questions = questions.error;
    else if (questions.value < 1) row.questions = 'Each topic needs at least 1 question.';
    topics.push({ name: topic.name, questions: 'value' in questions ? questions.value : 0 });
    return row;
  });

  const base: BlueprintResult = {
    examId,
    nameError,
    criteriaError: null,
    topicErrors,
    percentError,
    multipleError,
    criteria: null,
    encoded: null,
    criteriaHash: null,
    selectedCount: null,
  };
  if (input.topics.length === 0) return { ...base, criteriaError: 'Add at least one topic.' };
  if (percentError ?? multipleError ?? topicErrors.some((row) => row.name ?? row.questions)) return base;

  // The field checks above cover what the rows can show, so this is the protocol's own verdict on the whole.
  const criteria: Criteria = {
    maxSetterPercent: 'value' in percent ? percent.value : 0,
    minBankMultiple: 'value' in multiple ? multiple.value : 0,
    topics,
  };
  try {
    checkCriteria(criteria);
  } catch (error) {
    if (!(error instanceof CriteriaError)) throw error;
    return { ...base, criteriaError: error.message };
  }
  const bytes = encodeCriteria(criteria);
  return {
    ...base,
    criteria,
    encoded: toHex(bytes),
    criteriaHash: toHex(criteriaHash(bytes)),
    selectedCount: selectedCount(criteria),
  };
}

/* ----------------------------------------------------------------- Schedule */

export interface ScheduleInput {
  /** `YYYY-MM-DD HH:mm`, in the board's local time zone. */
  examStart: string;
  /** Δ in whole minutes. */
  deltaMinutes: string;
  lockTime: string;
  endTime: string;
}

export const emptySchedule: ScheduleInput = { examStart: '', deltaMinutes: '', lockTime: '', endTime: '' };

/** Reads `YYYY-MM-DD HH:mm` as local time, and rejects dates that do not exist. */
export function parseLocalTime(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute);
  const exact =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute;
  return exact ? Math.floor(date.getTime() / 1000) : null;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A clock time in the board's local time zone, with seconds. */
export function formatClock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

export interface RoundAtTime {
  /** The clock time that was entered, in Unix seconds. */
  entered: number;
  round: number;
  /** When drand produces that round. At or after `entered`. */
  producedAt: number;
}

export interface ScheduleResult {
  errors: { examStart?: string; deltaMinutes?: string; lockTime?: string; endTime?: string };
  /** The first rule `checkSchedule` or the clock rules reject, shown once. */
  scheduleError: string | null;
  examStart: number | null;
  delta: number | null;
  /** The unlock time, `T − Δ`. */
  lock: RoundAtTime | null;
  unlock: RoundAtTime | null;
  end: RoundAtTime | null;
  /** Complete and accepted by `checkSchedule`. */
  settings: ScheduleSettings | null;
}

export interface ScheduleSettings {
  examStart: number;
  delta: number;
  lockRound: string;
  unlockRound: string;
  endRound: string;
}

function roundAt(unixSeconds: number): RoundAtTime {
  const round = firstRoundAtOrAfter(unixSeconds);
  return { entered: unixSeconds, round, producedAt: roundTimeSeconds(round) };
}

const timeHint = 'Use YYYY-MM-DD HH:mm, for example 2027-03-14 09:30.';

/**
 * `lockRound` and `endRound` are the first rounds at or after the entered
 * times, and `unlockRound` is the first round at or after `T − Δ`, as
 * "Exam Settings" in spec/api.md requires. Rounds cannot change once published.
 */
export function evaluateSchedule(input: ScheduleInput, nowSeconds = Math.floor(Date.now() / 1000)): ScheduleResult {
  const errors: ScheduleResult['errors'] = {};
  const start = parseLocalTime(input.examStart);
  const lockTime = parseLocalTime(input.lockTime);
  const endTime = parseLocalTime(input.endTime);
  if (input.examStart.trim() === '') errors.examStart = 'Enter the exam start, T.';
  else if (start === null) errors.examStart = timeHint;
  if (input.lockTime.trim() === '') errors.lockTime = 'Enter the lock time.';
  else if (lockTime === null) errors.lockTime = timeHint;
  if (input.endTime.trim() === '') errors.endTime = 'Enter the end time.';
  else if (endTime === null) errors.endTime = timeHint;
  let delta: number | null = null;
  const minutes = input.deltaMinutes.trim();
  if (minutes === '') errors.deltaMinutes = 'Enter Δ in minutes.';
  else if (!wholeNumber.test(minutes) || Number(minutes) < 1) errors.deltaMinutes = 'Δ must be a whole number of minutes, at least 1.';
  else delta = Number(minutes) * 60;

  const empty: ScheduleResult = {
    errors,
    scheduleError: null,
    examStart: start,
    delta,
    lock: null,
    unlock: null,
    end: null,
    settings: null,
  };
  if (start === null || delta === null || lockTime === null || endTime === null) return empty;

  let lock: RoundAtTime;
  let unlock: RoundAtTime;
  let end: RoundAtTime;
  try {
    lock = roundAt(lockTime);
    unlock = roundAt(start - delta);
    end = roundAt(endTime);
  } catch (error) {
    if (error instanceof RangeError) return { ...empty, scheduleError: 'A time is before the drand quicknet genesis.' };
    throw error;
  }
  const found: ScheduleResult = { ...empty, lock, unlock, end };

  const settings: ScheduleSettings = {
    examStart: start,
    delta,
    lockRound: String(lock.round),
    unlockRound: String(unlock.round),
    endRound: String(end.round),
  };
  try {
    checkSchedule({ ...settings, chainId: chain.chainId });
  } catch (error) {
    if (!(error instanceof ScheduleError)) throw error;
    return { ...found, scheduleError: scheduleMessage(error) };
  }
  if (lockTime <= nowSeconds) {
    return { ...found, scheduleError: 'The lock time has already passed. Choose a time in the future.' };
  }
  return { ...found, settings };
}

function scheduleMessage(error: ScheduleError): string {
  switch (error.code) {
    case 'round_order':
      return 'The lock time must come before the unlock time (T − Δ), and the unlock time before the end time.';
    case 'end_round':
      return 'The end time must be after the exam start, T.';
    case 'before_genesis':
      return 'T − Δ is before the drand quicknet genesis.';
    case 'delta_zero':
      return 'Δ must not be zero.';
    default:
      return error.message;
  }
}

/* ------------------------------------------------------------------ Publish */

export interface PublishInput {
  /** The selected TEE version, a release tag. Empty until one is chosen. */
  version: string;
  rpcHost: string;
}

export const emptyPublish: PublishInput = { version: '', rpcHost: '' };

export interface PublishFields {
  commitHash: Hex;
  imageDigest: Hex;
  rpcHost: string;
  /** The release tag. Shown to the board; not stored on-chain. */
  version: string;
  /** The workflow run that built the release. Shown to the board; not stored on-chain. */
  run: string;
}

export interface PublishResult {
  errors: { release?: string; rpcHost?: string };
  fields: PublishFields | null;
}

const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * `release` is a release whose commit has been checked against its tag, or null.
 * Without one there are no fields, so nothing can be published.
 */
export function evaluatePublish(input: Pick<PublishInput, 'rpcHost'>, release: VerifiedRelease | null): PublishResult {
  const errors: PublishResult['errors'] = {};
  if (!release) errors.release = 'Select a version whose commit matches its tag.';
  const host = input.rpcHost.trim();
  if (!hostname.test(host)) {
    errors.rpcHost = 'Enter the hostname only, with no scheme, port or path, such as sepolia.example.org.';
  }
  if (!release || errors.rpcHost) return { errors, fields: null };
  return {
    errors,
    fields: {
      commitHash: release.commit,
      imageDigest: release.imageDigest,
      rpcHost: host,
      version: release.version,
      run: release.run,
    },
  };
}

/** The exact bytes sent as `criteria`, for read-back comparison. */
export const criteriaBytes = (encoded: Hex): Uint8Array => fromHex(encoded);

/** An empty field is incomplete, not wrong, so its error waits until something is typed. */
export const whenTyped = (value: string, error: string | null | undefined): string | undefined =>
  value.trim() === '' ? undefined : (error ?? undefined);
