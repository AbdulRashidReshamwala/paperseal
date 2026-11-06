import { readDirectory, readPartyRecords, type Directory, type EnsLookup, type PartyRecords } from '@paperseal/chain';
import { noInviteTag, ownerEnsName, passkeyRecordMatches, passkeyRecordValue, fromHex, roles, threshold, toHex, type ApprovedListEntry, type Hex } from '@paperseal/protocol';
import type { RegistrationEntry } from '@paperseal/tee-client';
import { useCallback, useMemo, useState } from 'react';

import { directoryName } from '../../shared/names';
import { usePoll } from './hooks';

/*
 * Who takes part, from "What the board accepts" in spec/api.md. The board picks permanent names and
 * gives each a list role. The choice is kept in this browser per exam, and holds nothing secret.
 * A registration joins the list only if its passkey hash equals the name's record, so a name with no
 * record, or a record for another key, stays off the list. Nothing here is read by the TEE.
 */

export const NAMES_POLL_MS = 15_000;

export interface ChosenParty {
  name: string;
  /** The list role, or null while the board must still choose one. */
  role: number | null;
}

/** The roles a party can be given. */
export const partyRoles: readonly number[] = [roles.neutral, roles.centreKeyHolder, roles.centre];

const storageKey = (examId: Hex) => `paperseal.parties.${examId.toLowerCase()}`;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Keeps only well-formed choices, never half-using one. */
export function validParties(parsed: unknown): ChosenParty[] {
  if (!Array.isArray(parsed)) return [];
  return (parsed as Partial<ChosenParty>[]).flatMap((item) => {
    if (typeof item.name !== 'string' || ownerEnsName(item.name) === null) return [];
    return [{ name: item.name, role: typeof item.role === 'number' && partyRoles.includes(item.role) ? item.role : null }];
  });
}

export function loadParties(examId: Hex): ChosenParty[] {
  try {
    const raw = storage()?.getItem(storageKey(examId));
    return raw ? validParties(JSON.parse(raw) as unknown) : [];
  } catch {
    return [];
  }
}

export function saveParties(examId: Hex, parties: readonly ChosenParty[]): void {
  try {
    storage()?.setItem(storageKey(examId), JSON.stringify(parties));
  } catch {
    // Not stored: the choice still works for this visit.
  }
}

/**
 * The role a newly ticked name starts with: a neutral place while one is free, then a centre key-holder
 * place. After that null, because nobody defaults to a centre without a part of the key.
 */
export function defaultRole(chosen: readonly ChosenParty[]): number | null {
  const taken = (role: number) => chosen.filter((party) => party.role === role).length;
  if (taken(roles.neutral) < threshold.neutrals) return roles.neutral;
  if (taken(roles.centreKeyHolder) < threshold.centres) return roles.centreKeyHolder;
  return null;
}

export type PartyState =
  /** Not read yet. */
  | { kind: 'reading' }
  /** The name could not be read, so nothing is known. The board can try again. */
  | { kind: 'unread'; reason: string }
  /** The name publishes no key, so nobody can match it. */
  | { kind: 'no-record' }
  /** The record is there, and its key has not registered yet. */
  | { kind: 'waiting' }
  /** Someone registered under this name with a different key. They stay off the list. */
  | { kind: 'other-key' }
  /** This key registered, and the record names it. */
  | { kind: 'registered'; registration: RegistrationEntry };

const zeroTag = toHex(noInviteTag);

/** The board's rule: the owner is the name, the tag is zero, and the passkey hash equals the record. */
export function partyState(name: string, records: PartyRecords | undefined, registrations: readonly RegistrationEntry[]): PartyState {
  if (!records) return { kind: 'reading' };
  if (records.state === 'missing') return { kind: 'no-record' };
  if (records.state !== 'found') return { kind: 'unread', reason: records.reason };
  const underName = registrations.filter((item) => item.owner === name);
  const registration = underName.find(
    (item) => item.derivedPublicKey !== '0x' && item.inviteTag === zeroTag && passkeyRecordMatches(records.passkey, passkeyRecordValue(item.passkeyPublicKey)),
  );
  if (registration) return { kind: 'registered', registration };
  return underName.length > 0 ? { kind: 'other-key' } : { kind: 'waiting' };
}

/** The approved list entries for the chosen names that registered and have a role. */
export function partyEntries(rows: readonly { party: ChosenParty; state: PartyState }[]): ApprovedListEntry[] {
  return rows.flatMap(({ party, state }) => {
    if (state.kind !== 'registered' || party.role === null) return [];
    const { registration } = state;
    return [
      {
        owner: registration.owner,
        role: party.role,
        passkeyPublicKey: fromHex(registration.passkeyPublicKey),
        derivedPublicKey: fromHex(registration.derivedPublicKey),
      },
    ];
  });
}

/** This exam's chosen names, read from the board's browser and saved back on every change. */
export function useParties(examId: Hex | null): { parties: readonly ChosenParty[]; update: (next: readonly ChosenParty[]) => void } {
  const [held, setHeld] = useState<{ examId: Hex | null; parties: readonly ChosenParty[] }>(() => ({
    examId,
    parties: examId ? loadParties(examId) : [],
  }));
  const parties = held.examId === examId ? held.parties : examId ? loadParties(examId) : [];
  const update = useCallback(
    (next: readonly ChosenParty[]) => {
      setHeld({ examId, parties: next });
      if (examId) saveParties(examId, next);
    },
    [examId],
  );
  return { parties, update };
}

/**
 * Reads each chosen name's records now and every `NAMES_POLL_MS`, only from the chain, through the
 * board's own RPC with no gateway. A failed read shows as unread and never stops the page. `retry`
 * reads again straight away.
 */
export function usePartyRecords(lookup: EnsLookup | null | undefined, names: readonly string[]): { records: Record<string, PartyRecords>; retry: () => void } {
  const key = JSON.stringify(names);
  const load = useMemo(() => {
    const list = JSON.parse(key) as string[];
    if (!lookup || list.length === 0) return null;
    return async () => {
      const found = await Promise.all(list.map(async (name) => [name, await readPartyRecords(name, { lookup })] as const));
      return Object.fromEntries(found);
    };
  }, [lookup, key]);
  const { value, reload } = usePoll(load, NAMES_POLL_MS);
  return { records: value ?? {}, retry: reload };
}

/** The names the directory lists, read now and every `NAMES_POLL_MS`. Each one is checked by its own records. */
export function useDirectoryNames(lookup: EnsLookup | null | undefined): { read: Directory | null; retry: () => void } {
  const load = useMemo(() => (lookup ? () => readDirectory(directoryName, { lookup }) : null), [lookup]);
  const { value, reload } = usePoll(load, NAMES_POLL_MS);
  return { read: value, retry: reload };
}
