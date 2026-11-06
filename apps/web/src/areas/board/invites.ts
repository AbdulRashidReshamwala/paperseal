import { checkInvite, encodeInviteLink, InviteError, newInviteSecret, type Hex, type Invite, type InviteRole } from '@paperseal/protocol';

/*
 * The board's invites, from "Invites" in spec/api.md. Only setters are invited. Each is one person's
 * link: a random secret and a role. They are kept in this browser only, per exam, so the board's app
 * can recompute every `inviteTag` and match it with what the TEE lists. Neither the secrets nor
 * setters' labels are sent anywhere or published.
 */

export interface BoardInvite {
  /** Stable across a reissue. Only used to tell invites apart here. */
  id: string;
  role: InviteRole;
  /** The board's own note for this invite, never published. */
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

/** Keeps the invites that pass `checkInvite` and drops the rest, never half-using one. */
export function validInvites(examId: Hex, parsed: unknown): BoardInvite[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: unknown) => {
    const value = item as Partial<BoardInvite> | null;
    if (!value || typeof value.id !== 'string' || typeof value.label !== 'string') return [];
    const invite = { examId, role: value.role as InviteRole, inviteSecret: value.inviteSecret as Hex };
    try {
      checkInvite(invite);
    } catch (error) {
      if (error instanceof InviteError) return [];
      throw error;
    }
    return [{ id: value.id, role: invite.role, label: value.label, inviteSecret: invite.inviteSecret }];
  });
}

/** Reads this exam's invites. Anything that doesn't pass `checkInvite` is dropped, never half-used. */
export function loadInvites(examId: Hex): BoardInvite[] {
  try {
    const raw = storage()?.getItem(storageKey(examId));
    return raw ? validInvites(examId, JSON.parse(raw) as unknown) : [];
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

/** A new setter invite. The text is only the board's own note, and may be empty. */
export function createInvite(existing: readonly BoardInvite[], text: string): BoardInvite {
  const note = text.trim();
  return {
    id: newInviteSecret().slice(2, 18),
    role: 'setter',
    label: note === '' ? `Setter ${String(existing.length + 1)}` : note,
    inviteSecret: newInviteSecret(),
  };
}

const BACKUP_KIND = 'paperseal-invites';

/** The backup file: everything needed to bring this exam's invites back. It holds the secret links. */
export function backupText(examId: Hex, invites: readonly BoardInvite[]): string {
  return JSON.stringify({ kind: BACKUP_KIND, version: 1, examId: examId.toLowerCase(), invites }, null, 2);
}

/** The invites in a backup for this exam, each checked again. Another exam's backup is refused. */
export function parseBackup(text: string, examId: Hex): { ok: true; invites: BoardInvite[] } | { ok: false; reason: string } {
  let value: { kind?: unknown; examId?: unknown; invites?: unknown } | null;
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    value = null;
  }
  if (!value || value.kind !== BACKUP_KIND || typeof value.examId !== 'string') {
    return { ok: false, reason: 'This file is not an invite backup from Paper Seal.' };
  }
  if (value.examId.toLowerCase() !== examId.toLowerCase()) {
    return { ok: false, reason: 'This backup is for a different exam. Open the exam it belongs to, then restore it there.' };
  }
  const invites = validInvites(examId, value.invites);
  if (invites.length === 0) return { ok: false, reason: 'This backup has no invites in it.' };
  return { ok: true, invites };
}

/** Adds the backup's invites to what is here. An invite already here, by id, stays as it is. */
export function mergeInvites(existing: readonly BoardInvite[], restored: readonly BoardInvite[]): BoardInvite[] {
  const ids = new Set(existing.map((invite) => invite.id));
  const secrets = new Set(existing.map((invite) => invite.inviteSecret));
  return [...existing, ...restored.filter((invite) => !ids.has(invite.id) && !secrets.has(invite.inviteSecret))];
}

/** The same invite with a new secret, so the old link and any key registered with it stop counting. */
export function reissueInvite(invite: BoardInvite): BoardInvite {
  return { ...invite, inviteSecret: newInviteSecret() };
}

export function linkFor(base: string, examId: Hex, invite: BoardInvite): string {
  return encodeInviteLink(base, { examId, role: invite.role, inviteSecret: invite.inviteSecret } satisfies Invite);
}
