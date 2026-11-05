import {
  checkInvite,
  encodeInviteLink,
  InviteError,
  newInviteSecret,
  ownerProblem,
  roles,
  type Hex,
  type Invite,
  type InviteRole,
} from '@paperseal/protocol';

/*
 * The board's invites, from "Invites" in spec/api.md. Each is one person's link: a random secret,
 * a role and, for key holders and centres, the name that goes on the public list. They are kept in
 * this browser only, per exam, so the board's app can recompute every `inviteTag` and match it with
 * what the TEE lists. Neither the secrets nor setters' labels are sent anywhere or published.
 */

export interface BoardInvite {
  /** Stable across a reissue. Only used to tell invites apart here. */
  id: string;
  role: InviteRole;
  /** The name on the approved list. Absent for a setter. */
  owner?: string;
  /** What the board calls this invite. For a setter it is the board's own note, never published. */
  label: string;
  inviteSecret: Hex;
}

const storageKey = (examId: Hex) => `paperseal.invites.${examId.toLowerCase()}`;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Reads this exam's invites. Anything that doesn't pass `checkInvite` is dropped, never half-used. */
export function loadInvites(examId: Hex): BoardInvite[] {
  try {
    const raw = storage()?.getItem(storageKey(examId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: unknown) => {
      const value = item as Partial<BoardInvite> | null;
      if (!value || typeof value.id !== 'string' || typeof value.label !== 'string') return [];
      const invite = { examId, role: value.role as InviteRole, inviteSecret: value.inviteSecret as Hex, ...(value.owner === undefined ? {} : { owner: value.owner }) };
      try {
        checkInvite(invite);
      } catch (error) {
        if (error instanceof InviteError) return [];
        throw error;
      }
      return [{ id: value.id, role: invite.role, label: value.label, inviteSecret: invite.inviteSecret, ...(invite.owner === undefined ? {} : { owner: invite.owner }) }];
    });
  } catch {
    return [];
  }
}

export function saveInvites(examId: Hex, invites: readonly BoardInvite[]): void {
  try {
    storage()?.setItem(storageKey(examId), JSON.stringify(invites));
  } catch {
    // Not stored: the invites still work for this visit, and the screen says nothing more can be done about it.
  }
}

export const inviteRoleNames: Record<InviteRole, string> = {
  setter: 'Setter',
  keyholder: 'Neutral party',
  centre: 'Centre',
};

/**
 * A new invite, or the reason it can't be made. Key holders and centres need a name that fits the
 * public list and isn't already invited. A setter's text is only the board's own note, and may be empty.
 */
export function createInvite(
  existing: readonly BoardInvite[],
  role: InviteRole,
  text: string,
): { ok: true; invite: BoardInvite } | { ok: false; reason: string } {
  const name = text.trim();
  const id = newInviteSecret().slice(2, 18);
  if (role === 'setter') {
    const label = name === '' ? `Setter ${String(existing.filter((invite) => invite.role === 'setter').length + 1)}` : name;
    return { ok: true, invite: { id, role, label, inviteSecret: newInviteSecret() } };
  }
  if (name === '') return { ok: false, reason: 'Enter the name to put on the approved list.' };
  const problem = ownerProblem(name);
  if (problem) return { ok: false, reason: problem };
  if (existing.some((invite) => invite.owner === name)) return { ok: false, reason: `${name} already has an invite.` };
  return { ok: true, invite: { id, role, owner: name, label: name, inviteSecret: newInviteSecret() } };
}

/** The same invite with a new secret, so the old link and any key registered with it stop counting. */
export function reissueInvite(invite: BoardInvite): BoardInvite {
  return { ...invite, inviteSecret: newInviteSecret() };
}

export function linkFor(base: string, examId: Hex, invite: BoardInvite): string {
  const full: Invite = {
    examId,
    role: invite.role,
    ...(invite.owner === undefined ? {} : { owner: invite.owner }),
    inviteSecret: invite.inviteSecret,
  };
  return encodeInviteLink(base, full);
}

/** The roles a centre can be given. Key holders and setters have exactly one, set by the invite. */
export const centreRoles: readonly number[] = [roles.centreKeyHolder, roles.centre];
