import { examIdFromName, newInviteSecret, type Hex } from '@paperseal/protocol';
import { describe, expect, it } from 'vitest';

import { createInvite, reissueInvite, validInvites, type BoardInvite } from './invites';
import { inviteEnsName, mayBeListed, nameStanding, type InviteNames } from './partyNames';

const examId = examIdFromName('physics-2027');
const keyholder = (extra: Partial<BoardInvite> = {}): BoardInvite => ({
  id: 'a',
  role: 'keyholder',
  owner: 'asha.eth',
  label: 'asha.eth',
  inviteSecret: newInviteSecret(),
  ...extra,
});

const passkey = (state: NonNullable<InviteNames['passkey']>['state']): InviteNames => ({
  passkey: { state, name: 'asha.eth', expected: `0x${'00'.repeat(32)}` as Hex, reason: state },
});

describe('invite names', () => {
  it('knows an ENS name for a key holder or centre, and never for a setter', () => {
    expect(inviteEnsName(keyholder())).toBe('asha.eth');
    expect(inviteEnsName(keyholder({ owner: 'Asha Rao' }))).toBeNull();
    expect(inviteEnsName({ role: 'setter' })).toBeNull();
    expect(inviteEnsName({ role: 'centre', owner: 'north.centres.maths-board.eth' })).toBe('north.centres.maths-board.eth');
  });

  it('makes an invite for an ENS name only, and says what to use for anything else', () => {
    expect(createInvite([], 'keyholder', 'asha.eth')).toMatchObject({ ok: true, invite: { owner: 'asha.eth' } });
    for (const role of ['keyholder', 'centre'] as const) {
      expect(createInvite([], role, 'Asha Rao')).toEqual({ ok: false, reason: 'Use an ENS name, like iit-delhi.eth.' });
      expect(createInvite([], role, 'centre-1')).toEqual({ ok: false, reason: 'Use an ENS name, like iit-delhi.eth.' });
    }
    expect(createInvite([], 'keyholder', '')).toMatchObject({ ok: false });
    expect(createInvite([], 'keyholder', 'Asha.eth')).toMatchObject({ ok: false, reason: expect.stringContaining('asha.eth') as string });
    expect(createInvite([], 'keyholder', `${'a'.repeat(126)}.eth`)).toMatchObject({ ok: false });
    const first = createInvite([], 'keyholder', 'asha.eth');
    if (!first.ok) throw new Error('expected an invite');
    expect(createInvite([first.invite], 'centre', 'asha.eth')).toMatchObject({ ok: false });
  });

  it('keeps the go-ahead only for a key holder, and drops it when the invite is reissued', () => {
    const kept = validInvites(examId, [keyholder({ goAhead: true })]);
    expect(kept[0]?.goAhead).toBe(true);
    expect(validInvites(examId, [{ ...keyholder({ role: 'centre' }), goAhead: true }])[0]?.goAhead).toBeUndefined();
    expect(reissueInvite(keyholder({ goAhead: true })).goAhead).toBeUndefined();
  });
});

describe('where a name stands', () => {
  it('is plain for a setter, whatever can be read', () => {
    expect(nameStanding({ role: 'setter' }, undefined, true)).toEqual({ kind: 'plain' });
    expect(mayBeListed({ role: 'setter' }, { kind: 'plain' })).toBe(true);
  });

  it('confirms only a matching record', () => {
    expect(nameStanding(keyholder(), passkey('confirmed'), true)).toEqual({ kind: 'confirmed' });
    expect(nameStanding(keyholder(), passkey('mismatch'), true)).toEqual({ kind: 'mismatch' });
    expect(nameStanding(keyholder(), passkey('missing'), true)).toEqual({ kind: 'unconfirmed', why: 'missing' });
    expect(nameStanding(keyholder(), passkey('refused'), true)).toEqual({ kind: 'unconfirmed', why: 'refused' });
    expect(nameStanding(keyholder(), passkey('unreadable'), true)).toEqual({ kind: 'unconfirmed', why: 'unreadable' });
    expect(nameStanding(keyholder(), undefined, true)).toEqual({ kind: 'reading' });
    expect(nameStanding(keyholder(), undefined, false)).toEqual({ kind: 'unconfirmed', why: 'unavailable' });
  });

  it('lists a key holder when confirmed or by choice, and never on a mismatch or before reading', () => {
    expect(mayBeListed(keyholder(), { kind: 'confirmed' })).toBe(true);
    expect(mayBeListed(keyholder(), { kind: 'unconfirmed', why: 'missing' })).toBe(false);
    expect(mayBeListed(keyholder({ goAhead: true }), { kind: 'unconfirmed', why: 'missing' })).toBe(true);
    expect(mayBeListed(keyholder({ goAhead: true }), { kind: 'mismatch' })).toBe(false);
    expect(mayBeListed(keyholder({ goAhead: true }), { kind: 'reading' })).toBe(false);
  });

  it('never holds a centre back for its name', () => {
    const centre = keyholder({ role: 'centre', owner: 'north.centres.maths-board.eth' });
    for (const standing of [{ kind: 'mismatch' }, { kind: 'reading' }, { kind: 'unconfirmed', why: 'missing' }] as const) {
      expect(mayBeListed(centre, standing)).toBe(true);
    }
  });
});
