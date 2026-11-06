import { checkPasskeyName, lookupPartyName, type EnsLookup, type PartyNameLookup, type PasskeyNameResult } from '@paperseal/chain';
import { ownerEnsName, type Hex, type InviteRole } from '@paperseal/protocol';
import { useMemo } from 'react';

import { usePoll } from './hooks';

/*
 * What the board knows about a party's ENS name, from "Party Names" in spec/api.md. A name is a label,
 * and for a neutral key holder it can also prove who holds the key. Nothing here is read by the TEE or
 * `ExamRegistry`. A key holder whose record does not match stays off the list. One whose record is not
 * there yet, or can't be read, waits, and the board may put them on the list marked unconfirmed.
 */

export const NAMES_POLL_MS = 15_000;

export interface InviteNames {
  /** Whether the name resolves at all. */
  lookup?: PartyNameLookup;
  /** Whether its record matches the registered key. Only read once a key has registered with the invite. */
  passkey?: PasskeyNameResult;
}

export type NameStanding =
  /** Not an ENS name, or a setter. Nothing to read. */
  | { kind: 'plain' }
  /** Not read yet. */
  | { kind: 'reading' }
  /** The record names this key. */
  | { kind: 'confirmed' }
  /** The record names a different key. */
  | { kind: 'mismatch' }
  /** No record, or it can't be read now. `unavailable`: this page has no way to read names. */
  | { kind: 'unconfirmed'; why: 'missing' | 'refused' | 'unreadable' | 'unavailable' };

interface NamedInvite {
  role: InviteRole;
  owner?: string;
  goAhead?: boolean;
}

/** The ENS name of an invite, for a key holder or a centre. Null for a plain name and for every setter. */
export function inviteEnsName(invite: Pick<NamedInvite, 'role' | 'owner'>): string | null {
  return invite.role === 'setter' || invite.owner === undefined ? null : ownerEnsName(invite.owner);
}

/** Where an invite's name stands once a key has registered with it. `names` is what the last read found. */
export function nameStanding(invite: NamedInvite, names: InviteNames | undefined, canRead: boolean): NameStanding {
  if (inviteEnsName(invite) === null) return { kind: 'plain' };
  if (!canRead) return { kind: 'unconfirmed', why: 'unavailable' };
  const result = names?.passkey;
  if (!result) return { kind: 'reading' };
  switch (result.state) {
    case 'confirmed':
      return { kind: 'confirmed' };
    case 'mismatch':
      return { kind: 'mismatch' };
    case 'missing':
      return { kind: 'unconfirmed', why: 'missing' };
    case 'refused':
      return { kind: 'unconfirmed', why: 'refused' };
    default:
      return { kind: 'unconfirmed', why: 'unreadable' };
  }
}

/**
 * Whether a registered invite may be on the list. A centre or plain name always may: a board-issued name
 * is a label and nothing waits on it. A key holder with an ENS name needs a confirmed record, or the
 * board's choice to go ahead without it. A record that names another key is never listed.
 */
export function mayBeListed(invite: NamedInvite, standing: NameStanding): boolean {
  if (invite.role !== 'keyholder') return true;
  switch (standing.kind) {
    case 'plain':
    case 'confirmed':
      return true;
    case 'mismatch':
    case 'reading':
      return false;
    case 'unconfirmed':
      return invite.goAhead === true;
  }
}

interface Target {
  id: string;
  name: string;
  /** The passkey that registered with the invite, once one has. */
  passkey?: Hex;
}

/**
 * Reads each ENS-named invite's name now and every `NAMES_POLL_MS`. Reads only the chain, through the
 * board's own RPC with no gateway. A failed read shows as unconfirmed and never stops the page.
 */
export function usePartyNames(lookup: EnsLookup | null | undefined, targets: readonly Target[]): Record<string, InviteNames> {
  const key = JSON.stringify(targets);
  const load = useMemo(() => {
    const list = JSON.parse(key) as Target[];
    if (!lookup || list.length === 0) return null;
    return async (): Promise<Record<string, InviteNames>> => {
      const found = await Promise.all(
        list.map(async (target): Promise<[string, InviteNames]> => {
          const [resolved, passkey] = await Promise.all([
            lookupPartyName(target.name, { lookup }),
            target.passkey ? checkPasskeyName(target.name, target.passkey, { lookup }) : Promise.resolve(undefined),
          ]);
          return [target.id, { lookup: resolved, ...(passkey ? { passkey } : {}) }];
        }),
      );
      return Object.fromEntries(found);
    };
  }, [lookup, key]);
  // `usePoll` gives nothing for a source it has not read yet, so an answer for another key is never used.
  const { value } = usePoll(load, NAMES_POLL_MS);
  return value ?? {};
}
