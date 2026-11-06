import {
  checkApprovedList,
  checkPartyNames,
  decodeInviteFragment,
  encodeInviteLink,
  fromHex,
  matchInvites,
  newInviteSecret,
  noInviteTag,
  passkeyRecordMatches,
  passkeyRecordValue,
  setterEntries,
  toHex,
  type ApprovedListEntry,
  type Hex,
  type Invite,
  type Matching,
  type TaggedRegistration,
} from '@paperseal/protocol';

import { ownerNameOf, type RosterEntry } from './roster';

/*
 * The list, the way the board app composes it (apps/web/src/areas/board): one invite per setter, and a
 * name per key holder or centre, which counts only if its record equals the hash of the key that
 * registered. The invite matching comes from @paperseal/protocol, the same function the board calls.
 * Nothing here touches the network.
 */

/** Where the links point. Only the fragment matters: no server is ever asked for it. */
export const linkBase = 'https://paperseal.example/';

/** One setter invite as the board holds it. */
export interface IssuedInvite extends Invite {
  /** The roster label, only for this driver: it is in no link and on no list. */
  name: string;
  link: string;
}

/** A new invite for each setter, with a fresh random secret. */
export function issueInvites(examId: Hex, setters: readonly RosterEntry[]): IssuedInvite[] {
  return setters.map((entry) => {
    const invite: Invite = { examId, role: 'setter', inviteSecret: newInviteSecret() };
    return { ...invite, name: entry.name, link: encodeInviteLink(linkBase, invite) };
  });
}

/** What the registrant's app reads from the link: the fragment only, strictly checked. */
export function openLink(link: string): Invite {
  return decodeInviteFragment(new URL(link).hash);
}

/** A key holder or centre the board chose: the name, its list role, and what the name's record holds. */
export interface ChosenName {
  entry: RosterEntry;
  /** The `ens.records.passkey` record. */
  record: Hex;
}

export interface Composed {
  matching: Matching<IssuedInvite, TaggedRegistration>;
  entries: ApprovedListEntry[];
  /** Registrations that fit no invite and no chosen name. */
  strays: TaggedRegistration[];
}

const zeroTag = toHex(noInviteTag);

/** The board's rule for a name: the owner is the name, the tag is zero, and the key's hash equals the record. */
export function registrationFor(chosen: ChosenName, registrations: readonly TaggedRegistration[]): TaggedRegistration | null {
  const name = ownerNameOf(chosen.entry);
  return (
    registrations.find(
      (item) => item.owner === name && item.derivedPublicKey !== '0x' && item.inviteTag === zeroTag && passkeyRecordMatches(chosen.record, passkeyRecordValue(item.passkeyPublicKey)),
    ) ?? null
  );
}

/**
 * Builds the entries as the board does. Throws if a chosen name has no matching registration, the
 * entries don't satisfy `checkApprovedList`, or a key holder or centre owner is not an ENS name.
 */
export function composeList(invites: readonly IssuedInvite[], names: readonly ChosenName[], registrations: readonly TaggedRegistration[]): Composed {
  const matching = matchInvites(invites, registrations);
  const parties = names.map((chosen) => {
    const registration = registrationFor(chosen, registrations);
    if (!registration) throw new Error(`${chosen.entry.name} has no registration that matches its record`);
    const entry: ApprovedListEntry = {
      owner: registration.owner,
      role: chosen.entry.role,
      passkeyPublicKey: fromHex(registration.passkeyPublicKey),
      derivedPublicKey: fromHex(registration.derivedPublicKey),
    };
    return entry;
  });
  const entries = [...setterEntries(matching), ...parties];
  checkApprovedList(entries);
  checkPartyNames(entries);
  const listed = new Set(entries.map((entry) => toHex(entry.passkeyPublicKey)));
  return { matching, entries, strays: registrations.filter((item) => !listed.has(item.passkeyPublicKey)) };
}
