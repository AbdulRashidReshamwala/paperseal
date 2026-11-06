import {
  ApprovedListError,
  checkApprovedList,
  checkPartyNames,
  encodeApprovedList,
  approvedListHash,
  fromHex,
  roles,
  toHex,
  type ApprovedListEntry,
  type Hex,
} from '@paperseal/protocol';

/*
 * Registrations come from `GET /v1/registrations`, which lists only what the TEE verified. The board's
 * app keeps the ones that match an invite (`invites.ts`) and gives each a role from the table in
 * "Approved List" in spec/api.md. The TEE also rejects a posted list that holds an entry it did not
 * verify at registration.
 */

/** A registration as the TEE returns it, with the role the board picked. */
export function withRoles(
  registrations: readonly { owner: string; passkeyPublicKey: Hex; derivedPublicKey: Hex }[],
  picked: Readonly<Record<string, number | undefined>>,
): ApprovedListEntry[] {
  return registrations.flatMap((registration) => {
    const role = picked[registration.passkeyPublicKey];
    if (role === undefined) return [];
    return [
      {
        owner: registration.owner,
        role,
        passkeyPublicKey: fromHex(registration.passkeyPublicKey),
        derivedPublicKey: fromHex(registration.derivedPublicKey),
      },
    ];
  });
}

export const roleNames: Record<number, string> = {
  [roles.setter]: 'Setter',
  [roles.neutral]: 'Key holder',
  [roles.centreKeyHolder]: 'Centre holding part of the key',
  [roles.centre]: 'Centre getting the key at unlock',
};

export interface ComposedList {
  encoded: Hex;
  /** The `approvedList` message hash that ExamRegistry stores and the TEE signs into the Build. */
  hash: Hex;
}

/** Validates with `checkApprovedList`, refuses a key holder or centre owner that is not an ENS name, then encodes with `encodeApprovedList`. Throws `ApprovedListError` in words. */
export function composeApprovedList(examId: Hex, entries: readonly ApprovedListEntry[]): ComposedList {
  checkApprovedList(entries);
  checkPartyNames(entries);
  const encoded = encodeApprovedList(entries);
  return { encoded: toHex(encoded), hash: toHex(approvedListHash(fromHex(examId), encoded)) };
}

/** `composeApprovedList`, or the reason it cannot be composed. */
export function tryCompose(
  examId: Hex,
  entries: readonly ApprovedListEntry[],
): { ok: true; list: ComposedList } | { ok: false; reason: string } {
  try {
    return { ok: true, list: composeApprovedList(examId, entries) };
  } catch (error) {
    if (error instanceof ApprovedListError) return { ok: false, reason: error.message };
    throw error;
  }
}
