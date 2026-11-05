import { criteriaHash, encodeCriteria, examIdFromName, firstRoundAtOrAfter, roundTimeSeconds, toHex } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import {
  evaluateBlueprint,
  evaluatePublish,
  evaluateSchedule,
  parseLocalTime,
  type BlueprintInput,
} from './form';

const blueprint = (patch: Partial<BlueprintInput> = {}): BlueprintInput => ({
  name: 'Physics 2027',
  topics: [
    { name: 'Mechanics', questions: '5' },
    { name: 'Optics', questions: '3' },
  ],
  maxSetterPercent: '20',
  minBankMultiple: '4',
  ...patch,
});

describe('evaluateBlueprint', () => {
  it('encodes valid criteria and shows selectedCount and criteriaHash', () => {
    const result = evaluateBlueprint(blueprint());
    const criteria = {
      maxSetterPercent: 20,
      minBankMultiple: 4,
      topics: [
        { name: 'Mechanics', questions: 5 },
        { name: 'Optics', questions: 3 },
      ],
    };
    expect(result.selectedCount).toBe(8);
    expect(result.encoded).toBe(toHex(encodeCriteria(criteria)));
    expect(result.criteriaHash).toBe(toHex(criteriaHash(encodeCriteria(criteria))));
    expect(result.examId).toBe(examIdFromName('Physics 2027'));
  });

  it.each([
    ['percent above 100', { maxSetterPercent: '101' }, 'percentError'],
    ['percent zero', { maxSetterPercent: '0' }, 'percentError'],
    ['percent not a number', { maxSetterPercent: '2.5' }, 'percentError'],
    ['multiple below 2', { minBankMultiple: '1' }, 'multipleError'],
    ['name with a trailing space', { name: 'Physics ' }, 'nameError'],
  ] as const)('rejects %s', (_label, patch, field) => {
    const result = evaluateBlueprint(blueprint(patch));
    expect(result[field]).toBeTruthy();
    if (field === 'nameError') expect(result.examId).toBeNull();
    else expect(result.criteria).toBeNull();
  });

  it('rejects zero questions, repeated topics and an empty topic list', () => {
    expect(evaluateBlueprint(blueprint({ topics: [{ name: 'A', questions: '0' }] })).topicErrors[0]?.questions).toBeTruthy();
    const repeated = evaluateBlueprint(blueprint({ topics: [{ name: 'A', questions: '1' }, { name: 'A', questions: '1' }] }));
    expect(repeated.topicErrors[1]?.name).toMatch(/unique/);
    expect(repeated.criteria).toBeNull();
    expect(evaluateBlueprint(blueprint({ topics: [] })).criteriaError).toMatch(/at least one topic/);
  });

  it('reports a selected count that overflows uint32 from the protocol check', () => {
    const result = evaluateBlueprint(
      blueprint({ topics: [{ name: 'A', questions: '4294967295' }, { name: 'B', questions: '4294967295' }] }),
    );
    expect(result.criteriaError).toMatch(/uint32/);
    expect(result.criteriaHash).toBeNull();
  });
});

describe('parseLocalTime', () => {
  it('reads local clock times and rejects dates that do not exist', () => {
    expect(parseLocalTime('2027-03-14 09:30')).toBe(Math.floor(new Date(2027, 2, 14, 9, 30).getTime() / 1000));
    expect(parseLocalTime('2027-02-31 09:30')).toBeNull();
    expect(parseLocalTime('tomorrow')).toBeNull();
  });
});

describe('evaluateSchedule', () => {
  const now = Math.floor(new Date(2027, 0, 1).getTime() / 1000);
  const input = {
    examStart: '2027-03-14 09:30',
    deltaMinutes: '30',
    lockTime: '2027-03-01 12:00',
    endTime: '2027-03-14 12:30',
  };

  it('derives rounds at or after each clock time and accepts the schedule', () => {
    const result = evaluateSchedule(input, now);
    expect(result.scheduleError).toBeNull();
    const start = parseLocalTime(input.examStart) ?? 0;
    expect(result.unlock?.round).toBe(firstRoundAtOrAfter(start - 1800));
    expect(result.unlock?.producedAt).toBe(roundTimeSeconds(result.unlock?.round ?? 0));
    expect(result.unlock?.producedAt).toBeGreaterThanOrEqual(start - 1800);
    expect(result.settings).toMatchObject({ examStart: start, delta: 1800 });
    expect(result.settings?.lockRound).toBe(String(result.lock?.round));
  });

  it('rejects a lock time after unlock, an end before T, and a past lock time', () => {
    expect(evaluateSchedule({ ...input, lockTime: '2027-03-14 09:20' }, now).scheduleError).toMatch(/lock time must come before/);
    expect(evaluateSchedule({ ...input, endTime: '2027-03-14 09:00' }, now).scheduleError).toBeTruthy();
    expect(evaluateSchedule(input, parseLocalTime('2027-03-02 00:00') ?? 0).scheduleError).toMatch(/already passed/);
    expect(evaluateSchedule({ ...input, deltaMinutes: '0' }, now).errors.deltaMinutes).toBeTruthy();
  });

  it('flags times that are not clock times', () => {
    const result = evaluateSchedule({ ...input, examStart: 'soon' }, now);
    expect(result.errors.examStart).toBeTruthy();
    expect(result.settings).toBeNull();
  });
});

describe('evaluatePublish', () => {
  const good = { commitHash: 'a'.repeat(40), imageDigest: `sha256:${'B'.repeat(64)}`, rpcHost: 'rpc.example.org' };

  it('normalises hex and drops the sha256 prefix', () => {
    expect(evaluatePublish(good).fields).toEqual({
      commitHash: `0x${'a'.repeat(40)}`,
      imageDigest: `0x${'b'.repeat(64)}`,
      rpcHost: 'rpc.example.org',
    });
  });

  it.each([
    [{ commitHash: 'abc' }, 'commitHash'],
    [{ imageDigest: 'zz' }, 'imageDigest'],
    [{ rpcHost: 'https://rpc.example.org' }, 'rpcHost'],
    [{ rpcHost: 'rpc.example.org:8545' }, 'rpcHost'],
    [{ rpcHost: 'rpc.example.org/path' }, 'rpcHost'],
  ] as const)('rejects %j', (patch, field) => {
    const result = evaluatePublish({ ...good, ...patch });
    expect(result.errors[field]).toBeTruthy();
    expect(result.fields).toBeNull();
  });
});
