import { describe, expect, it } from 'vitest';

import { evaluateSchedule, parseLocalTime } from './form';
import {
  bankNeeded,
  defaultLockSeconds,
  defaultPlan,
  defaultRpcHost,
  draftScreen,
  plainWords,
  toLocalInput,
  toSchedule,
  verifierUrl,
} from './plan';

const DAY = 86400;
const now = 1_900_000_000;
const inDays = (days: number) => now + days * DAY;

describe('toSchedule', () => {
  const plan = { ...defaultPlan, examStart: toLocalInput(inDays(30)).replace(' ', 'T'), releaseMinutes: '10', durationMinutes: '180' };

  it('adds the duration to get the end, and passes the rules of form.ts', () => {
    const input = toSchedule(plan, now);
    expect(parseLocalTime(input.endTime)).toBe((parseLocalTime(plan.examStart) ?? 0) + 180 * 60);
    expect(input.deltaMinutes).toBe('10');
    expect(evaluateSchedule(input, now).settings).not.toBeNull();
  });

  it('closes questions a day before the release', () => {
    const start = parseLocalTime(plan.examStart) ?? 0;
    expect(parseLocalTime(toSchedule(plan, now).lockTime)).toBe(start - 600 - DAY);
  });

  it('closes questions halfway for an exam within a day', () => {
    expect(defaultLockSeconds(now + 7200, now)).toBe(now + 3600);
  });

  it('uses the time the board typed instead', () => {
    expect(toSchedule({ ...plan, lockTime: '2030-01-01T10:00' }, now).lockTime).toBe('2030-01-01T10:00');
  });

  it('leaves the worked-out times empty until there is something to work from', () => {
    expect(toSchedule(defaultPlan, now)).toMatchObject({ lockTime: '', endTime: '' });
    expect(toSchedule({ ...plan, durationMinutes: 'soon' }, now).endTime).toBe('');
    expect(toSchedule({ ...plan, durationMinutes: '0' }, now).endTime).toBe('');
    expect(toSchedule({ ...plan, releaseMinutes: 'soon' }, now).lockTime).toBe('');
  });
});

describe('bankNeeded', () => {
  it('states what the limits come to', () => {
    const topics = [{ name: 'A', questions: 5 }, { name: 'B', questions: 3 }];
    expect(bankNeeded({ maxSetterPercent: 20, minBankMultiple: 4, topics })).toEqual({ questions: 32, setters: 5 });
    expect(bankNeeded({ maxSetterPercent: 30, minBankMultiple: 2, topics })).toEqual({ questions: 16, setters: 4 });
  });
});

describe('plainWords', () => {
  it('rewrites the words the design rules out of primary screens', () => {
    expect(plainWords('ExamRegistry only accepts writes from the TEE')).toBe('the public record only accepts writes from Paper Seal');
    expect(plainWords('Not published on ExamRegistry.')).toBe('Not published on the public record.');
    expect(plainWords('Each topic needs its own name.')).toBe('Each topic needs its own name.');
  });
});

describe('configuration', () => {
  it('takes the provider host from the RPC URL, never its path', () => {
    expect(defaultRpcHost({ VITE_RPC_URL: 'https://sepolia.example.org/v2/secret' })).toBe('sepolia.example.org');
    expect(defaultRpcHost({ VITE_RPC_URL: 'not a url' })).toBe('');
    expect(defaultRpcHost({})).toBe('');
  });

  it('links only an http or https verifier', () => {
    expect(verifierUrl({ VITE_VERIFIER_URL: 'https://verify.example.org/' })).toBe('https://verify.example.org/');
    expect(verifierUrl({ VITE_VERIFIER_URL: 'javascript:alert(1)' })).toBeNull();
    expect(verifierUrl({})).toBeNull();
  });
});

describe('draftScreen', () => {
  const ready = { create: true, version: true };
  it('sends the board back to the first unfinished step', () => {
    expect(draftScreen('review', { create: false, version: true })).toBe('create');
    expect(draftScreen('review', { create: true, version: false })).toBe('version');
    expect(draftScreen('review', ready)).toBe('review');
    expect(draftScreen('version', ready)).toBe('version');
    expect(draftScreen('create', ready)).toBe('create');
  });
});
