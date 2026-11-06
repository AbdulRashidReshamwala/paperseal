import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { equalBytes, fromHex, toHex, utf8ToBytes } from './bytes';
import { roles, setterOwner, type ApprovedListEntry } from './encoding';
import { limits } from './constants';
import type { Hex } from './types';

/*
 * Invites, from "Invites" in spec/api.md. Only setters are invited. An invite is a random 32-byte
 * secret plus its role, sent as a link whose URL fragment holds all of it, so no server sees it.
 * `inviteTag = HMAC-SHA-256(inviteSecret, passkeyPublicKey)` is signed into the `registration`
 * message, and the board recomputes it from its own copy of the invite. Key holders and centres have
 * a permanent ENS name instead, and register with `noInviteTag` (spec/api.md, "Party Names").
 *
 * Link shape (a design choice the spec leaves open): the app routes on the fragment, so the invite is
 * the query of the `/join` route: `<page>#/join?exam=0x..&role=setter&secret=0x..`.
 */

export const inviteSecretBytes = 32;
/** The TEE refuses an `owner` longer than this many UTF-8 bytes, `limits.ownerBytes`, the same cap the approved list has. */
export const maxOwnerBytes = limits.ownerBytes;

/** `inviteTag` of a registration by name: 32 zero bytes, which keeps the field in the signed message. */
export const noInviteTag: Uint8Array = new Uint8Array(inviteSecretBytes);

export const inviteRoles = ['setter'] as const;
export type InviteRole = (typeof inviteRoles)[number];

export interface Invite {
  examId: Hex;
  role: InviteRole;
  inviteSecret: Hex;
}

export class InviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteError';
  }
}

/** A fresh random `inviteSecret`, from the platform's CSPRNG. */
export function newInviteSecret(): Hex {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(inviteSecretBytes)));
}

/** `HMAC-SHA-256(inviteSecret, passkeyPublicKey)`, the `bytes32 inviteTag` of the `registration` message. */
export function inviteTag(inviteSecret: Uint8Array, passkeyPublicKey: Uint8Array): Uint8Array {
  if (inviteSecret.length !== inviteSecretBytes) throw new RangeError('inviteSecret must be 32 bytes');
  if (passkeyPublicKey.length !== 65 || passkeyPublicKey[0] !== 0x04) {
    throw new RangeError('passkeyPublicKey must be a 65-byte uncompressed point starting with 0x04');
  }
  return hmac(sha256, inviteSecret, passkeyPublicKey);
}

const hex32 = /^0x[0-9a-f]{64}$/;

/** The `owner` rules the TEE enforces: not empty, valid UTF-8, at most `limits.ownerBytes` bytes. Also no edge spaces or control characters. */
export function ownerProblem(owner: string): string | null {
  if (owner.length === 0) return 'The name is empty.';
  if (owner !== owner.trim()) return 'The name starts or ends with a space.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(owner)) return 'The name has a control character.';
  try {
    encodeURIComponent(owner);
  } catch {
    return 'The name is not valid text.';
  }
  if (utf8ToBytes(owner).length > maxOwnerBytes) return `The name is longer than ${String(maxOwnerBytes)} bytes.`;
  return null;
}

/** Checks an invite's shape. Throws `InviteError` with the first problem. */
export function checkInvite(invite: Invite): void {
  if (!hex32.test(invite.examId)) throw new InviteError('The exam is not 32 bytes of lowercase hex.');
  if (!hex32.test(invite.inviteSecret)) throw new InviteError('The secret is not 32 bytes of lowercase hex.');
  if (!inviteRoles.includes(invite.role)) throw new InviteError('Only setters are invited by link.');
}

const joinPrefix = '#/join?';
const linkKeys = ['exam', 'role', 'secret'];

/** The fragment of an invite link, `#/join?...`. Validates first. */
export function encodeInviteFragment(invite: Invite): string {
  checkInvite(invite);
  const params = new URLSearchParams();
  params.set('exam', invite.examId);
  params.set('role', invite.role);
  params.set('secret', invite.inviteSecret);
  return `${joinPrefix}${params.toString()}`;
}

/** The full link: the page's address without any fragment, then the invite fragment. */
export function encodeInviteLink(base: string, invite: Invite): string {
  return `${base.split('#')[0] ?? ''}${encodeInviteFragment(invite)}`;
}

/**
 * Reads an invite from `location.hash`. Strict: exactly the expected keys, each once, nothing else,
 * and every value checked as `checkInvite` does. Throws `InviteError`, never returns a partial invite.
 */
export function decodeInviteFragment(fragment: string): Invite {
  if (!fragment.startsWith(joinPrefix)) throw new InviteError('This is not an invite link.');
  const query = fragment.slice(joinPrefix.length);
  const seen = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(query)) {
    if (seen.has(key)) throw new InviteError(`The link repeats ${key}.`);
    seen.set(key, value);
  }
  for (const key of seen.keys()) {
    if (!linkKeys.includes(key)) throw new InviteError(`The link has an unexpected part, ${key}.`);
  }
  for (const key of linkKeys) {
    if (!seen.has(key)) throw new InviteError(`The link is missing ${key}.`);
  }
  const invite = {
    examId: seen.get('exam') as Hex,
    role: seen.get('role') as InviteRole,
    inviteSecret: seen.get('secret') as Hex,
  };
  checkInvite(invite);
  return invite;
}

/** Whether `registration` belongs to `invite`: its tag is the HMAC of the invite's secret over its own passkey, its owner is that passkey's `setterOwner` hash, and it has no derived key. */
export function registrationMatchesInvite(
  invite: Pick<Invite, 'inviteSecret'>,
  registration: { owner: string; passkeyPublicKey: Hex; derivedPublicKey: Hex; inviteTag: Hex },
): boolean {
  if (!hex32.test(registration.inviteTag)) return false;
  let passkey: Uint8Array;
  try {
    passkey = fromHex(registration.passkeyPublicKey);
  } catch {
    return false;
  }
  if (passkey.length !== 65 || passkey[0] !== 0x04) return false;
  if (!equalBytes(inviteTag(fromHex(invite.inviteSecret), passkey), fromHex(registration.inviteTag))) return false;
  return registration.derivedPublicKey === '0x' && registration.owner === setterOwner(passkey);
}

/* ------------------------------------------------------------------ Matching */

/** A registration as `GET /v1/registrations` returns it. */
export interface TaggedRegistration {
  owner: string;
  passkeyPublicKey: Hex;
  derivedPublicKey: Hex;
  inviteTag: Hex;
}

/** What the board keeps of an invite to match against. */
export type InviteSecret = Pick<Invite, 'inviteSecret'>;

export type InviteState<R extends TaggedRegistration = TaggedRegistration> =
  | { kind: 'waiting' }
  | { kind: 'matched'; registration: R }
  /** Two or more passkeys carry this invite's tag. None is listed until the invite is reissued. */
  | { kind: 'conflict'; registrations: R[] };

export interface Matching<I extends InviteSecret = InviteSecret, R extends TaggedRegistration = TaggedRegistration> {
  /** One row per invite, in the order given. */
  rows: { invite: I; state: InviteState<R> }[];
  /** Registrations that fit no invite: a party, nobody invited, a copied tag, or the wrong kind of key. */
  unmatched: R[];
}

/**
 * The board's rule from spec/api.md. Each registration's tag is recomputed from every invite's secret.
 * A registration joins an invite only if its tag and owner match, and an invite with two matching
 * passkeys lists neither until it is reissued. Nothing the TEE says about a tag is taken on trust.
 */
export function matchInvites<I extends InviteSecret, R extends TaggedRegistration>(
  invites: readonly I[],
  registrations: readonly R[],
): Matching<I, R> {
  const claimed = new Set<string>();
  const rows = invites.map((invite) => {
    const found = new Map<string, R>();
    for (const registration of registrations) {
      const key = registration.passkeyPublicKey;
      if (!claimed.has(key) && registrationMatchesInvite(invite, registration)) found.set(key, registration);
    }
    for (const key of found.keys()) claimed.add(key);
    const matches = [...found.values()];
    const state: InviteState<R> =
      matches.length === 0
        ? { kind: 'waiting' }
        : matches.length === 1
          ? { kind: 'matched', registration: matches[0] as R }
          : { kind: 'conflict', registrations: matches };
    return { invite, state };
  });
  return { rows, unmatched: registrations.filter((registration) => !claimed.has(registration.passkeyPublicKey)) };
}

/** The approved list entries for the matched setters. */
export function setterEntries(matching: Matching): ApprovedListEntry[] {
  return matching.rows.flatMap(({ state }) => {
    if (state.kind !== 'matched') return [];
    const { registration } = state;
    return [
      {
        owner: registration.owner,
        role: roles.setter,
        passkeyPublicKey: fromHex(registration.passkeyPublicKey),
        derivedPublicKey: fromHex(registration.derivedPublicKey),
      },
    ];
  });
}
