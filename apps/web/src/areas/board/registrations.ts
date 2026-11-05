import {
  ApprovedListError,
  checkApprovedList,
  encodeApprovedList,
  approvedListHash,
  fromHex,
  roles,
  toHex,
  type ApprovedListEntry,
  type Hex,
} from '@paperseal/protocol';

/*
 * Registrations come from `GET /v1/registrations`, which lists only what the TEE verified. The role
 * is the board's choice, from the table in "Approved List" in spec/api.md. The TEE also rejects a
 * posted list that holds an entry it did not verify at registration.
 */

/** The roles a registration can take: a setter has no derived key, every other role has one. */
export function rolesFor(derivedPublicKey: Hex): number[] {
  return derivedPublicKey === '0x' ? [roles.setter] : [roles.neutral, roles.centreKeyHolder, roles.centre];
}

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
  [roles.neutral]: 'Neutral party',
  [roles.centreKeyHolder]: 'Centre, key holder',
  [roles.centre]: 'Centre, no share',
};

export interface ComposedList {
  encoded: Hex;
  /** The `approvedList` message hash that ExamRegistry stores and the TEE signs into the Build. */
  hash: Hex;
}

/** Validates with `checkApprovedList`, then encodes with `encodeApprovedList`. Throws `ApprovedListError` in words. */
export function composeApprovedList(examId: Hex, entries: readonly ApprovedListEntry[]): ComposedList {
  checkApprovedList(entries);
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
