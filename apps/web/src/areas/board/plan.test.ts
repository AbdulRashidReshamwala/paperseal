import { roles } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import { evaluateSchedule, parseLocalTime } from './form';
import {
  bankNeeded,
  defaultLockSeconds,
  defaultPlan,
  defaultRpcHost,
  draftScreen,
  plainWords,
  registrationLinks,
  toLocalInput,
  toSchedule,
  verifierUrl,
} from './plan';
import { defaultRoles } from './registrations';

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
    expect(plainWords('The lock time has already passed. Choose a time in the future.')).toBe('Questions would close in the past. Choose a later time.');
    expect(plainWords('ExamRegistry only accepts writes from the TEE')).toBe('the public record only accepts writes from the sealed machine');
    expect(plainWords('Not published on ExamRegistry.')).toBe('Not published on the public record.');
    expect(plainWords('Topic names must be unique.')).toBe('Topic names must be unique.');
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

describe('registrationLinks', () => {
  it('gives each role a link that names the exam', () => {
    const examId = `0x${'11'.repeat(32)}` as const;
    const links = registrationLinks(examId, 'https://exam.example.org/');
    expect(links.map((link) => link.url)).toEqual([
      `https://exam.example.org/#/setter?exam=${examId}`,
      `https://exam.example.org/#/keyholder?exam=${examId}`,
      `https://exam.example.org/#/centre?exam=${examId}`,
    ]);
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

describe('defaultRoles', () => {
  const holder = (n: number, owner: string) => ({
    owner,
    passkeyPublicKey: `0x${String(n).padStart(2, '0')}` as const,
    derivedPublicKey: `0x04${String(n).padStart(2, '0')}` as const,
  });
  const setter = { owner: `0x${'ab'.repeat(32)}`, passkeyPublicKey: '0xee', derivedPublicKey: '0x' } as const;

  it('makes a setter a setter, and a centre a centre by its name', () => {
    const picked = defaultRoles([setter, holder(1, 'Delhi Exam Centre'), holder(2, 'Mumbai Center'), holder(3, 'Asha')]);
    expect(picked).toEqual({
      '0xee': roles.setter,
      '0x01': roles.centreKeyHolder,
      '0x02': roles.centreKeyHolder,
      '0x03': roles.neutral,
    });
  });

  it('keeps neutral places for people whose names say nothing, whatever the order', () => {
    const named = Array.from({ length: 7 }, (_, i) => holder(i + 4, `Centre ${String(i)}`));
    const picked = defaultRoles([holder(1, 'Asha'), holder(2, 'Ben'), holder(3, 'Chen'), ...named]);
    expect(Object.values(picked).filter((role) => role === roles.neutral)).toHaveLength(3);
    expect(Object.values(picked).filter((role) => role === roles.centreKeyHolder)).toHaveLength(7);
  });

  it('fills the neutral places, then the centres, and leaves out the rest', () => {
    const everyone = Array.from({ length: 11 }, (_, i) => holder(i + 1, `Person ${String(i)}`));
    const picked = defaultRoles(everyone);
    expect(picked['0x03']).toBe(roles.neutral);
    expect(picked['0x04']).toBe(roles.centreKeyHolder);
    expect(picked['0x10']).toBe(roles.centreKeyHolder);
    expect(picked['0x11']).toBeUndefined();
  });
});
