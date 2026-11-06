import {
  checkApprovedList,
  checkPartyNames,
  decodeInviteFragment,
  encodeInviteLink,
  entriesFor,
  listRolesFor,
  matchInvites,
  newInviteSecret,
  roles,
  type ApprovedListEntry,
  type Hex,
  type Invite,
  type InviteRole,
  type Matching,
  type TaggedRegistration,
} from '@paperseal/protocol';

import { ownerNameOf, type Kind, type RosterEntry } from './roster';

/*
 * Invites, the way the board app does them (apps/web/src/areas/board/invites.ts): one random secret per
 * person, a link with everything in its URL fragment, and a list composed by matching what the TEE
 * lists against those invites. The matching and the roles come from @paperseal/protocol, the same
 * functions the board calls, so the driver can't drift from it. Nothing here touches the network.
 */

/** Where the links point. Only the fragment matters: no server is ever asked for it. */
export const linkBase = 'https://paperseal.example/';

const inviteRoleOf: Record<Kind, InviteRole> = {
  setter: 'setter',
  neutral: 'keyholder',
  'centre-holder': 'centre',
  centre: 'centre',
};

/** One invite as the board holds it, with the roster entry it was made for. */
export interface IssuedInvite extends Invite {
  /** The roster name. For a setter it is only this driver's label: it is in no link and on no list. */
  name: string;
  /** The approved-list role this person is meant to get. A centre's share place is the board's choice. */
  listRole: RosterEntry['role'];
  link: string;
}

/** A new invite for each person, with a fresh random secret. Setters get no owner. */
export function issueInvites(examId: Hex, people: readonly RosterEntry[]): IssuedInvite[] {
  return people.map((entry) => {
    const role = inviteRoleOf[entry.kind];
    const invite: Invite = {
      examId,
      role,
      ...(role === 'setter' ? {} : { owner: ownerNameOf(entry) as string }),
      inviteSecret: newInviteSecret(),
    };
    return { ...invite, name: entry.name, listRole: entry.role, link: encodeInviteLink(linkBase, invite) };
  });
}

/** What the registrant's app reads from the link: the fragment only, strictly checked. */
export function openLink(link: string): Invite {
  return decodeInviteFragment(new URL(link).hash);
}

export interface Composed {
  matching: Matching<IssuedInvite, TaggedRegistration>;
  entries: ApprovedListEntry[];
}

/**
 * Matches the registrations against the invites and builds the entries, as the board does. A centre's
 * share place goes to the first seven, and the board's own choice covers the rest: here, the roster's.
 * Throws if the entries don't satisfy `checkApprovedList`, or a key holder or centre owner is not an ENS name.
 */
export function composeFromInvites(invites: readonly IssuedInvite[], registrations: readonly TaggedRegistration[]): Composed {
  const matching = matchInvites(invites, registrations);
  const picked: Record<string, number | undefined> = { ...listRolesFor(matching) };
  for (const { invite, state } of matching.rows) {
    if (state.kind === 'matched' && invite.listRole === roles.centre) picked[state.registration.passkeyPublicKey] = roles.centre;
  }
  const entries = entriesFor(matching, picked);
  checkApprovedList(entries);
  checkPartyNames(entries);
  return { matching, entries };
}
