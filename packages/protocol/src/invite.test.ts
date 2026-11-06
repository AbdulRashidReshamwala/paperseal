import { describe, expect, it } from 'vitest';

import {
  checkInvite,
  decodeInviteFragment,
  encodeInviteFragment,
  encodeInviteLink,
  fromHex,
  InviteError,
  inviteTag,
  limits,
  maxOwnerBytes,
  newInviteSecret,
  ownerProblem,
  registrationMatchesInvite,
  setterOwner,
  toHex,
  type Hex,
  type Invite,
} from './index';

const examId = `0x${'11'.repeat(32)}` as Hex;
const secret = `0x${'a3'.repeat(32)}` as Hex;
const point = (n: number) => {
  const key = new Uint8Array(65).fill(n);
  key[0] = 0x04;
  return key;
};
const holder: Invite = { examId, role: 'keyholder', owner: 'Ada Lovelace', inviteSecret: secret };
const setter: Invite = { examId, role: 'setter', inviteSecret: secret };

describe('inviteTag', () => {
  it('is HMAC-SHA-256, the same MAC WebCrypto computes', () => {
    const key = new Uint8Array(32);
    key.set(new TextEncoder().encode('Jefe'));
    const message = point(9);
    return globalThis.crypto.subtle
      .importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then((k) => globalThis.crypto.subtle.sign('HMAC', k, message))
      .then((mac) => {
        expect(toHex(inviteTag(key, message))).toBe(toHex(new Uint8Array(mac)));
      });
  });

  it('binds the passkey and the secret', () => {
    const a = inviteTag(fromHex(secret), point(1));
    expect(a).toHaveLength(32);
    expect(toHex(inviteTag(fromHex(secret), point(2)))).not.toBe(toHex(a));
    expect(toHex(inviteTag(fromHex(`0x${'44'.repeat(32)}`), point(1)))).not.toBe(toHex(a));
  });

  it('refuses a secret or key of the wrong size', () => {
    expect(() => inviteTag(new Uint8Array(31), point(1))).toThrow('32 bytes');
    expect(() => inviteTag(fromHex(secret), new Uint8Array(64))).toThrow('65-byte');
  });

  it('makes random 32-byte secrets', () => {
    expect(newInviteSecret()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(newInviteSecret()).not.toBe(newInviteSecret());
  });
});

describe('invite links', () => {
  it('round-trips a holder and a setter, and keeps the secret in the fragment only', () => {
    for (const invite of [holder, setter, { ...holder, owner: 'Zoë & Co = "centre" 100%' }]) {
      const link = encodeInviteLink('https://app.example/exam/', invite);
      const url = new URL(link);
      expect(url.search).toBe('');
      expect(url.hash.startsWith('#/join?')).toBe(true);
      expect(link.startsWith('https://app.example/exam/#/join?')).toBe(true);
      expect(decodeInviteFragment(url.hash)).toEqual(invite);
    }
    expect(encodeInviteFragment(setter)).not.toContain('owner');
  });

  it('replaces any fragment on the base', () => {
    expect(encodeInviteLink('https://a.example/#/board', setter).split('#')).toHaveLength(2);
  });

  const good = encodeInviteFragment(holder);
  const bad: [string, string][] = [
    ['another route', good.replace('#/join', '#/setter')],
    ['no fragment', ''],
    ['a missing secret', good.replace(/&secret=[^&]*/, '')],
    ['a missing owner', good.replace(/&owner=[^&]*/, '')],
    ['a repeated key', `${good}&role=setter`],
    ['an extra key', `${good}&extra=1`],
    ['an unknown role', good.replace('role=keyholder', 'role=board')],
    ['an uppercase secret', good.replace(secret.slice(2), secret.slice(2).toUpperCase())],
    ['a short secret', good.replace(secret, secret.slice(0, -2))],
    ['a secret with no 0x', good.replace('secret=0x', 'secret=')],
    ['a short exam', good.replace(examId, examId.slice(0, -2))],
    ['an empty owner', good.replace(/owner=[^&]*/, 'owner=')],
    ['a padded owner', good.replace('owner=Ada+Lovelace', 'owner=+Ada')],
    ['a control character in the owner', good.replace('Ada', 'A%00da')],
    ['a long owner', good.replace(/owner=[^&]*/, `owner=${'a'.repeat(limits.ownerBytes + 1)}`)],
    ['an owner on a setter', `${encodeInviteFragment(setter)}&owner=x`],
  ];
  it.each(bad)('refuses %s', (_name, fragment) => {
    expect(() => decodeInviteFragment(fragment)).toThrow(InviteError);
  });

  it('allows an owner of exactly limits.ownerBytes and refuses one byte more, the approved list cap', () => {
    expect(maxOwnerBytes).toBe(limits.ownerBytes);
    expect(ownerProblem('a'.repeat(limits.ownerBytes))).toBeNull();
    expect(() => checkInvite({ ...holder, owner: 'a'.repeat(limits.ownerBytes) })).not.toThrow();
    expect(ownerProblem('a'.repeat(limits.ownerBytes + 1))).toBe(`The name is longer than ${String(limits.ownerBytes)} bytes.`);
    expect(() => checkInvite({ ...holder, owner: 'a'.repeat(limits.ownerBytes + 1) })).toThrow(InviteError);
  });

  it('counts owner bytes, not characters', () => {
    expect(ownerProblem('é'.repeat(limits.ownerBytes / 2))).toBeNull();
    expect(ownerProblem('é'.repeat(limits.ownerBytes / 2 + 1))).toMatch(/longer than/);
  });

  it('checks an invite before encoding it', () => {
    expect(() => encodeInviteFragment({ ...holder, owner: undefined as never })).toThrow(InviteError);
    expect(() => checkInvite({ ...holder, inviteSecret: '0x12' })).toThrow(InviteError);
  });
});

describe('registrationMatchesInvite', () => {
  const registration = (invite: Invite, owner: string, derived: Hex, passkey = point(1)) => ({
    owner,
    passkeyPublicKey: toHex(passkey),
    derivedPublicKey: derived,
    inviteTag: toHex(inviteTag(fromHex(invite.inviteSecret), passkey)),
  });
  const derived = toHex(point(2));

  it('matches a holder by tag and name', () => {
    expect(registrationMatchesInvite(holder, registration(holder, 'Ada Lovelace', derived))).toBe(true);
  });

  it('refuses another name, another secret, a copied tag and a missing derived key', () => {
    expect(registrationMatchesInvite(holder, registration(holder, 'Someone Else', derived))).toBe(false);
    expect(registrationMatchesInvite({ ...holder, inviteSecret: `0x${'44'.repeat(32)}` }, registration(holder, 'Ada Lovelace', derived))).toBe(false);
    const copied = { ...registration(holder, 'Ada Lovelace', derived, point(1)), passkeyPublicKey: toHex(point(3)) };
    expect(registrationMatchesInvite(holder, copied)).toBe(false);
    expect(registrationMatchesInvite(holder, registration(holder, 'Ada Lovelace', '0x'))).toBe(false);
  });

  it('matches a setter only by its own setterOwner hash and without a derived key', () => {
    const owner = setterOwner(point(1));
    expect(registrationMatchesInvite(setter, registration(setter, owner, '0x'))).toBe(true);
    expect(registrationMatchesInvite(setter, registration(setter, 'Ada', '0x'))).toBe(false);
    expect(registrationMatchesInvite(setter, registration(setter, owner, derived))).toBe(false);
  });

  it('treats a malformed tag as no match', () => {
    expect(registrationMatchesInvite(holder, { ...registration(holder, 'Ada Lovelace', derived), inviteTag: '0x12' })).toBe(false);
  });
});
