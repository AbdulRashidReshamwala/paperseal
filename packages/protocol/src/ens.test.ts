import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { labelhash, namehash } from 'viem/ens';
import { describe, expect, it } from 'vitest';

import {
  ApprovedListError,
  checkPartyNames,
  partyNameProblem,
  roles,
  ens,
  ensNameProblem,
  examIdFromName,
  examNameProblem,
  limits,
  looksLikeEnsName,
  ownerEnsName,
  passkeyRecordValue,
  setterOwner,
  splitExamEnsName,
} from './index';

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
    expect(ens.records).toEqual({ tee: 'paperseal.tee', storage: 'paperseal.storage', bucket: 'paperseal.bucket',
      passkey: 'paperseal.passkey',
    });
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
    expect(examNameProblem('JEE-Main-2026')).toMatch(/^Use lowercase letters.*Did you mean jee-main-2026\?$/);
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

describe('party names', () => {
  it('knows an ENS name from a plain name', () => {
    for (const name of ['dr-rao.eth', 'north.centres.maths-board.eth', 'maths-board.eth']) expect(ownerEnsName(name), name).toBe(name);
    for (const plain of ['Dr. Rao', 'Delhi Public School', 'Rao', 'dr rao.eth', '']) expect(ownerEnsName(plain), plain).toBeNull();
  });

  it('does not treat a name that is not normalised as one, and says what to use', () => {
    expect(looksLikeEnsName('Dr-Rao.eth')).toBe(true);
    expect(ownerEnsName('Dr-Rao.eth')).toBeNull();
    expect(ensNameProblem('Dr-Rao.eth')).toContain('dr-rao.eth');
    expect(ensNameProblem('dr_rao.eth')).toBeTruthy();
    expect(ensNameProblem('dr-rao.eth')).toBeNull();
  });

  it('refuses a name over the owner limit in bytes, not characters', () => {
    const long = `${'a'.repeat(limits.ownerBytes)}.eth`;
    expect(ensNameProblem(long)).toContain(String(limits.ownerBytes));
    expect(ownerEnsName(long)).toBeNull();
    const wide = `${'é'.repeat(64)}.eth`;
    expect(wide.length).toBeLessThan(limits.ownerBytes);
    expect(ensNameProblem(wide)).toContain(String(limits.ownerBytes));
  });

  it('records the setterOwner hash of the passkey, a fixed vector', () => {
    const key = new Uint8Array(65).fill(0xab);
    key[0] = 4;
    expect(passkeyRecordValue(key)).toBe(setterOwner(key));
    expect(passkeyRecordValue(key)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(passkeyRecordValue(`0x${Buffer.from(key).toString('hex')}`)).toBe(passkeyRecordValue(key));
  });
});

describe('party names for key holders and centres', () => {
  const entry = (role: number, owner: string) => ({
    role,
    owner,
    passkeyPublicKey: new Uint8Array(65),
    derivedPublicKey: new Uint8Array(0),
  });

  it('gives the one plain line, or the normalised name', () => {
    expect(partyNameProblem('iit-delhi.eth')).toBeNull();
    expect(partyNameProblem('north-1.centres.maths-board.eth')).toBeNull();
    expect(partyNameProblem('Dr Rao')).toBe('Use an ENS name, like iit-delhi.eth.');
    expect(partyNameProblem('plain')).toBe('Use an ENS name, like iit-delhi.eth.');
    expect(partyNameProblem('Dr-Rao.eth')).toContain('Did you mean dr-rao.eth?');
  });

  it('refuses a list with a plain owner for a key holder or centre, and ignores setters', () => {
    expect(() => checkPartyNames([entry(roles.setter, '0xabc'), entry(roles.neutral, 'a.eth'), entry(roles.centre, 'b.centres.x.eth')])).not.toThrow();
    for (const role of [roles.neutral, roles.centreKeyHolder, roles.centre]) {
      expect(() => checkPartyNames([entry(role, 'centre-1')])).toThrow(ApprovedListError);
    }
  });
});
