import type { PartyRecords } from '@paperseal/chain';
import { noInviteTag, passkeyRecordValue, roles, threshold, toHex, type Hex } from '@paperseal/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { defaultRole, loadParties, partyEntries, partyState, saveParties, validParties, type ChosenParty } from './parties';

const name = 'centre-1.paperseal-demo.eth';
const passkey = `0x04${'07'.repeat(64)}` as Hex;
const derived = `0x04${'08'.repeat(64)}` as Hex;
const found: PartyRecords = { state: 'found', name, passkey: passkeyRecordValue(passkey), credentialId: '0x01' };
const registration = { owner: name, passkeyPublicKey: passkey, derivedPublicKey: derived, inviteTag: toHex(noInviteTag) };

describe('partyState', () => {
  it('registers only a key whose hash equals the record, under this name, with a zero tag and a derived key', () => {
    expect(partyState(name, found, [registration])).toEqual({ kind: 'registered', registration });
    expect(partyState(name, found, [])).toEqual({ kind: 'waiting' });
    expect(partyState(name, found, [{ ...registration, owner: 'other.eth' }])).toEqual({ kind: 'waiting' });
    expect(partyState(name, found, [{ ...registration, passkeyPublicKey: `0x04${'09'.repeat(64)}` }])).toEqual({ kind: 'other-key' });
    expect(partyState(name, found, [{ ...registration, inviteTag: `0x${'77'.repeat(32)}` }])).toEqual({ kind: 'other-key' });
    expect(partyState(name, found, [{ ...registration, derivedPublicKey: '0x' }])).toEqual({ kind: 'other-key' });
  });

  it('tells no record from an unread name', () => {
    expect(partyState(name, undefined, [])).toEqual({ kind: 'reading' });
    expect(partyState(name, { state: 'missing', name, reason: '' }, [registration])).toEqual({ kind: 'no-record' });
    expect(partyState(name, { state: 'unreadable', name, reason: 'down' }, [registration])).toEqual({ kind: 'unread', reason: 'down' });
    expect(partyState(name, { state: 'refused', name, reason: 'gateway' }, [registration])).toEqual({ kind: 'unread', reason: 'gateway' });
  });
});

describe('partyEntries', () => {
  it('lists a registered name that has a role, and nobody else', () => {
    const party: ChosenParty = { name, role: roles.centreKeyHolder };
    const entries = partyEntries([
      { party, state: { kind: 'registered', registration } },
      { party: { name, role: null }, state: { kind: 'registered', registration } },
      { party, state: { kind: 'waiting' } },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ owner: name, role: roles.centreKeyHolder });
  });
});

describe('defaultRole', () => {
  it('fills neutral places, then key places, then asks', () => {
    const fill = (role: number, count: number) => Array.from({ length: count }, (_, i) => ({ name: `${String(role)}-${String(i)}.eth`, role }));
    expect(defaultRole([])).toBe(roles.neutral);
    expect(defaultRole(fill(roles.neutral, threshold.neutrals))).toBe(roles.centreKeyHolder);
    expect(defaultRole([...fill(roles.neutral, threshold.neutrals), ...fill(roles.centreKeyHolder, threshold.centres)])).toBeNull();
  });
});

describe('storage', () => {
  const examId = `0x${'11'.repeat(32)}` as Hex;
  beforeEach(() => {
    const items = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value) },
    });
  });

  it('keeps choices per exam', () => {
    saveParties(examId, [{ name, role: roles.centre }]);
    expect(loadParties(examId)).toEqual([{ name, role: roles.centre }]);
    expect(loadParties(`0x${'22'.repeat(32)}`)).toEqual([]);
  });

  it('drops what does not read, and a role that is not a party role', () => {
    expect(validParties([{ name: 'Plain Name', role: roles.neutral }, { name, role: roles.setter }, 'x'])).toEqual([{ name, role: null }]);
    expect(validParties('nope')).toEqual([]);
  });
});
