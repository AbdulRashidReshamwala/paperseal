import { chain, drand } from './constants';
import type { ExamSettings } from './types';

/** Unix seconds at which a quicknet round is produced. */
export function roundTimeSeconds(round: number): number {
  return drand.genesisTime + (round - 1) * drand.periodSeconds;
}

/** The latest quicknet round produced by a Unix time, in seconds. */
export function roundAtSeconds(unixSeconds: number): number {
  if (unixSeconds < drand.genesisTime) return 0;
  return Math.floor((unixSeconds - drand.genesisTime) / drand.periodSeconds) + 1;
}

/** The first quicknet round produced at or after a Unix time: `ceil((t − genesisTime) / periodSeconds) + 1`. */
export function firstRoundAtOrAfter(unixSeconds: number): number {
  if (unixSeconds < drand.genesisTime) {
    throw new RangeError('time is before drand.genesisTime');
  }
  return Math.ceil((unixSeconds - drand.genesisTime) / drand.periodSeconds) + 1;
}

export type ScheduleErrorCode =
  | 'chain_id'
  | 'round_order'
  | 'delta_zero'
  | 'before_genesis'
  | 'unlock_round'
  | 'end_round';

/** A `createExam` rejection from "Exam Settings" in spec/api.md, caught before spending gas. */
export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

/** Throws a `ScheduleError` for the first rule `createExam` (or the chain check) would reject. */
export function checkSchedule(
  settings: Pick<ExamSettings, 'examStart' | 'delta' | 'lockRound' | 'unlockRound' | 'endRound' | 'chainId'>,
): void {
  const { examStart, delta } = settings;
  if (settings.chainId !== chain.chainId) {
    throw new ScheduleError('chain_id', `chainId must be ${String(chain.chainId)}`);
  }
  const [lock, unlock, end] = [settings.lockRound, settings.unlockRound, settings.endRound].map((round) => {
    if (!/^(0|[1-9][0-9]*)$/.test(round)) throw new TypeError('rounds must be decimal strings');
    return BigInt(round);
  }) as [bigint, bigint, bigint];
  if (!(lock < unlock && unlock < end)) {
    throw new ScheduleError('round_order', 'lockRound < unlockRound < endRound must hold');
  }
  if (delta === 0) throw new ScheduleError('delta_zero', 'delta must not be zero');
  const openAt = examStart - delta;
  if (openAt <= drand.genesisTime) {
    throw new ScheduleError('before_genesis', 'examStart − delta must be after drand.genesisTime');
  }
  const expected = firstRoundAtOrAfter(openAt);
  if (unlock !== BigInt(expected)) {
    throw new ScheduleError('unlock_round', `unlockRound must be ${String(expected)}, the first round at or after examStart − delta`);
  }
  if (BigInt(drand.genesisTime) + (end - 1n) * BigInt(drand.periodSeconds) <= BigInt(examStart)) {
    throw new ScheduleError('end_round', 'endRound must be produced after examStart');
  }
}

/**
 * The attested startup arguments: one `--<kebab-name>=<value>` per Exam
 * Settings field, in table order. Hex is lowercase, integers are decimal.
 */
export function startupArgs(settings: ExamSettings): string[] {
  const int = (name: string, value: number | string): string => {
    const text = String(value);
    if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new TypeError(`${name} must be a decimal integer`);
    return text;
  };
  const hex = (name: string, value: string): string => {
    if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new TypeError(`${name} must be 0x-prefixed hex`);
    return value.toLowerCase();
  };
  return [
    ['exam-id', hex('examId', settings.examId)],
    ['exam-start', int('examStart', settings.examStart)],
    ['delta', int('delta', settings.delta)],
    ['lock-round', int('lockRound', settings.lockRound)],
    ['unlock-round', int('unlockRound', settings.unlockRound)],
    ['end-round', int('endRound', settings.endRound)],
    ['criteria-hash', hex('criteriaHash', settings.criteriaHash)],
    ['rpc-host', settings.rpcHost],
    ['registry', hex('registry', settings.registry)],
    ['chain-id', int('chainId', settings.chainId)],
  ].map(([name, value]) => `--${name as string}=${value as string}`);
}
