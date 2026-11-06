import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { labelhash, namehash } from 'viem/ens';
import { describe, expect, it } from 'vitest';

import { ens, examIdFromName, examNameProblem, splitExamEnsName } from './index';

/*
 * Checks against spec/fixtures/exam-names.json, whose examIds were computed with viem. The file is
 * committed, so a missing or malformed file fails here and never skips.
 */

interface ExamNames {
  valid: { label: string; examId: string }[];
  invalid: { label: string; reason: string }[];
  names: { name: string; label: string; parent: string; examId: string; namehash: string; parentNamehash: string }[];
}

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../spec/fixtures/exam-names.json'), 'utf8'),
) as ExamNames;

describe('exam names', () => {
  it('reads spec/ens.json', () => {
    expect(ens.records).toEqual({ tee: 'paperseal.tee', storage: 'paperseal.storage', bucket: 'paperseal.bucket' });
    expect(ens.ccipRead).toBe(false);
  });

  it('accepts every valid fixture, and its examId is the viem labelhash', () => {
    expect(fixtures.valid.length).toBeGreaterThan(0);
    for (const { label, examId } of fixtures.valid) {
      expect(examNameProblem(label), label).toBeNull();
      expect(examIdFromName(label), label).toBe(examId);
      expect(labelhash(label), label).toBe(examId);
    }
  });

  it('keeps the jee-main-2026 vector fixed', () => {
    expect(examIdFromName('jee-main-2026')).toBe('0xa8ec8fb4eda3d90b6190127d877227895bcd634a849e7f3a355311ed10637556');
    expect(examIdFromName('🎓-2026')).toBe('0xf72a6a1d7823bbf61eda085b52d7038f45dd25f21ae6256fe0e83264e5fab3f7');
  });

  it('refuses every invalid fixture', () => {
    expect(fixtures.invalid.length).toBeGreaterThan(0);
    for (const { label, reason } of fixtures.invalid) {
      expect(examNameProblem(label), `${label}: ${reason}`).toEqual(expect.any(String));
    }
  });

  it('explains the problem in plain words', () => {
    expect(examNameProblem('')).toBe('The exam name is empty.');
    expect(examNameProblem('jee.main')).toMatch(/dot/);
    expect(examNameProblem('JEE-Main-2026')).toMatch(/normalised form.*jee-main-2026\?$/);
    const space = examNameProblem('Maths 2026') ?? '';
    expect(space).toMatch(/^Use lowercase letters, digits and hyphens, like jee-main-2026\./);
    expect(space).not.toMatch(/[‎‏]/);
  });

  it('splits and hashes every fixture name as viem does', () => {
    expect(fixtures.names.length).toBeGreaterThan(0);
    for (const fixture of fixtures.names) {
      expect(splitExamEnsName(fixture.name)).toEqual({ label: fixture.label, parent: fixture.parent });
      expect(examIdFromName(fixture.label)).toBe(fixture.examId);
      expect(namehash(fixture.name)).toBe(fixture.namehash);
      expect(namehash(fixture.parent)).toBe(fixture.parentNamehash);
    }
  });

  it('splits at the first dot only', () => {
    expect(splitExamEnsName('maths-2026.board.example.eth')).toEqual({ label: 'maths-2026', parent: 'board.example.eth' });
    for (const name of ['', 'maths-2026', '.eth', 'maths-2026.', '.']) expect(splitExamEnsName(name), name).toBeNull();
  });
});
