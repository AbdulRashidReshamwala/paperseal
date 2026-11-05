import { fromHex, isSetterCommitment, setterCommitment, toHex, type Hex } from '@paperseal/protocol';

/*
 * Setter invites. The approved list holds only a salted hash of each setter's name, so the board
 * keeps the name and salt here, in this browser's localStorage per exam, until the end round.
 * Nothing in this file is on-chain, and the names must never be shown as if they were.
 */

export interface Invite {
  name: string;
  /** 32 random bytes, lowercase 0x hex. Given to the setter with the commitment. */
  salt: Hex;
  /** `setterCommitment(examId, name, salt)`, which is the owner the setter registers under. */
  commitment: Hex;
}

export interface InviteStore {
  invites: Invite[];
  /** Unix milliseconds of the one-time export, once the board has saved it and removed the salts. */
  exportedAt: number | null;
}

const storageKey = (examId: Hex) => `paperseal.invites.${examId.toLowerCase()}`;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

const isHex32 = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);

export function loadInvites(examId: Hex): InviteStore {
  const empty: InviteStore = { invites: [], exportedAt: null };
  try {
    const raw = storage()?.getItem(storageKey(examId));
    if (!raw) return empty;
    const value = JSON.parse(raw) as { invites?: unknown; exportedAt?: unknown };
    const invites = Array.isArray(value.invites) ? (value.invites as Partial<Invite>[]) : [];
    return {
      invites: invites.flatMap((invite) =>
        typeof invite.name === 'string' &&
        isHex32(invite.salt) &&
        isHex32(invite.commitment) &&
        // A stored commitment that no longer recomputes is corrupt, and is dropped.
        setterCommitment(fromHex(examId), invite.name, fromHex(invite.salt)) === invite.commitment
          ? [{ name: invite.name, salt: invite.salt, commitment: invite.commitment }]
          : [],
      ),
      exportedAt: typeof value.exportedAt === 'number' ? value.exportedAt : null,
    };
  } catch {
    return empty;
  }
}

export function saveInvites(examId: Hex, store: InviteStore): void {
  storage()?.setItem(storageKey(examId), JSON.stringify(store));
}

export class InviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteError';
  }
}

/** Fills with `crypto.getRandomValues`. Tests pass their own source. */
export type RandomBytes = (length: number) => Uint8Array;
export const browserRandom: RandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/** A new invite for a name: a fresh 32-byte salt and the commitment over the exam, name and salt. */
export function createInvite(examId: Hex, rawName: string, existing: readonly Invite[], random: RandomBytes = browserRandom): Invite {
  const name = rawName.trim();
  if (name === '') throw new InviteError('Enter the setter’s name.');
  if (existing.some((invite) => invite.name === name)) throw new InviteError(`${name} already has an invite for this exam.`);
  const salt = random(32);
  if (salt.length !== 32) throw new InviteError('The random source did not return 32 bytes.');
  const commitment = setterCommitment(fromHex(examId), name, salt);
  if (!isSetterCommitment(commitment)) throw new InviteError('The commitment is malformed.');
  return { name, salt: toHex(salt), commitment };
}

/** The JSON the board publishes after the end round: `[{name, salt}]`, which the verifier page reads. */
export function exportInvites(invites: readonly Invite[]): string {
  return JSON.stringify(
    invites.map(({ name, salt }) => ({ name, salt })),
    null,
    2,
  );
}

/** The text a setter needs. It is the only way they learn the commitment to register under. */
export function inviteMessage(invite: Invite): string {
  return `Commitment (register with this): ${invite.commitment}\nSalt (keep it): ${invite.salt}`;
}
