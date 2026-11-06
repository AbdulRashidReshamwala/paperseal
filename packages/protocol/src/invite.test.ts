import { describe, expect, it } from 'vitest';

import {
  checkInvite,
  decodeInviteFragment,
  encodeInviteFragment,
  encodeInviteLink,
  fromHex,
  inviteTag,
  matchInvites,
  newInviteSecret,
  noInviteTag,
  roles,
  setterEntries,
  setterOwner,
  toHex,
  type Hex,
  type Invite,
  type TaggedRegistration,
} from './index';

const examId = `0x${'11'.repeat(32)}` as Hex;
const key = (byte: number): Hex => `0x04${byte.toString(16).padStart(2, '0').repeat(64)}`;

const invite = (): Invite => ({ examId, role: 'setter', inviteSecret: newInviteSecret() });

const registered = (held: Invite, passkey: Hex): TaggedRegistration => ({
  owner: setterOwner(fromHex(passkey)),
  passkeyPublicKey: passkey,
  derivedPublicKey: '0x',
  inviteTag: toHex(inviteTag(fromHex(held.inviteSecret), fromHex(passkey))),
});

describe('invite links', () => {
  it('round-trips a setter invite through its fragment', () => {
    const made = invite();
    expect(decodeInviteFragment(encodeInviteFragment(made))).toEqual(made);
    expect(encodeInviteLink('https://a.example/x#old', made).startsWith('https://a.example/x#/join?')).toBe(true);
  });

  it('refuses every role but setter, so a key holder or centre link no longer opens', () => {
    const made = invite();
    for (const role of ['keyholder', 'centre']) {
      expect(() => {
        checkInvite({ ...made, role } as unknown as Invite);
      }).toThrow('Only setters');
    }
    const old = encodeInviteFragment(made).replace('role=setter', 'role=keyholder');
    expect(() => decodeInviteFragment(old)).toThrow('Only setters');
    expect(() => decodeInviteFragment(`${encodeInviteFragment(made)}&owner=a.eth`)).toThrow('unexpected part');
  });

  it('refuses a repeated key and a link with a part missing', () => {
    const fragment = encodeInviteFragment(invite());
    expect(() => decodeInviteFragment(`${fragment}&role=setter`)).toThrow('repeats');
    expect(() => decodeInviteFragment(fragment.replace(/&secret=.*/, ''))).toThrow('missing secret');
    expect(() => decodeInviteFragment('#/other')).toThrow('not an invite');
  });
});

describe('matchInvites', () => {
  it('matches by the recomputed tag and lists the setter', () => {
    const held = invite();
    const matching = matchInvites([held], [registered(held, key(1))]);
    expect(matching.rows[0]?.state.kind).toBe('matched');
    const [entry] = setterEntries(matching);
    expect(entry?.role).toBe(roles.setter);
    expect(entry?.owner).toBe(setterOwner(fromHex(key(1))));
  });

  it('never matches a copied tag, a derived key, or a registration by name', () => {
    const held = invite();
    const copied = { ...registered(held, key(1)), passkeyPublicKey: key(2) };
    const holder = { ...registered(held, key(3)), derivedPublicKey: key(4) };
    const byName = { owner: 'centre-1.paperseal-demo.eth', passkeyPublicKey: key(5), derivedPublicKey: key(6), inviteTag: toHex(noInviteTag) };
    const matching = matchInvites([held], [copied, holder, byName]);
    expect(matching.rows[0]?.state.kind).toBe('waiting');
    expect(matching.unmatched).toHaveLength(3);
  });

  it('lists neither of two keys that used one invite', () => {
    const held = invite();
    const matching = matchInvites([held], [registered(held, key(1)), registered(held, key(2))]);
    expect(matching.rows[0]?.state.kind).toBe('conflict');
    expect(setterEntries(matching)).toEqual([]);
  });
});
