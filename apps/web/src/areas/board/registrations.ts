import {
  ApprovedListError,
  checkApprovedList,
  encodeApprovedList,
  approvedListHash,
  fromHex,
  roles,
  threshold,
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
  [roles.centreKeyHolder]: 'Centre with a key',
  [roles.centre]: 'Centre without a key',
};

const looksLikeCentre = (owner: string) => /\bcent(re|er)\b/i.test(owner);

/**
 * A first guess at each role, for the board to correct. A name that says it's a centre takes a
 * centre's place, and everyone else fills the neutral places, then the centre places, in the order
 * they registered. Whoever doesn't fit is left out, and nobody defaults to a centre without a key:
 * that role receives the paper's key at unlock, so giving it is always the board's own choice.
 * Registrations don't carry a role, so this is only ever a default.
 */
export function defaultRoles(registrations: readonly { owner: string; passkeyPublicKey: Hex; derivedPublicKey: Hex }[]) {
  const picked: Record<string, number> = {};
  let neutrals = 0;
  let centres = 0;
  const placeCentre = (key: Hex) => {
    if (centres === threshold.centres) return;
    picked[key] = roles.centreKeyHolder;
    centres += 1;
  };
  const holders = registrations.filter((registration) => registration.derivedPublicKey !== '0x');
  for (const registration of registrations) {
    if (registration.derivedPublicKey === '0x') picked[registration.passkeyPublicKey] = roles.setter;
  }
  for (const holder of holders) {
    if (looksLikeCentre(holder.owner)) placeCentre(holder.passkeyPublicKey);
  }
  for (const holder of holders) {
    if (looksLikeCentre(holder.owner)) continue;
    if (neutrals < threshold.neutrals) {
      picked[holder.passkeyPublicKey] = roles.neutral;
      neutrals += 1;
    } else {
      placeCentre(holder.passkeyPublicKey);
    }
  }
  return picked;
}

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
