import type { ExamRegistry } from '@paperseal/chain';
import { decodeApprovedList, fromHex, toHex, type ApprovedListEntry, type Hex } from '@paperseal/protocol';
import { useMemo } from 'react';

import { getCurrentExamId, useCurrentExamId } from './currentExam';
import { loadCredential, type StoredCredential } from './Register';

/** The roles that hold a derived key. Each registers separately, so one browser can be both. */
export type HolderRole = 'keyholder' | 'centre';

/** The credential Register.tsx stored in this browser for the current exam and this role. */
export function holderCredential(role: HolderRole, exam: Hex | null = getCurrentExamId()): StoredCredential | null {
  return exam ? loadCredential(exam, role) : null;
}

/** `holderCredential`, following the current exam. */
export function useHolderCredential(role: HolderRole): StoredCredential | null {
  const exam = useCurrentExamId();
  return useMemo(() => holderCredential(role, exam), [role, exam]);
}

/**
 * This credential's entry on the on-chain approved list, which carries the derived public key
 * that names its files in storage. Null before the list is posted or if the key is not on it.
 * `getApprovedListEntries` has already hashed the bytes against the chain's `listHash`.
 */
export async function listEntryFor(
  registry: Pick<ExamRegistry, 'getApprovedListEntries'>,
  exam: Hex,
  passkeyPublicKey: Hex,
): Promise<ApprovedListEntry | null> {
  const entries = await registry.getApprovedListEntries(exam);
  if (!entries) return null;
  return (
    decodeApprovedList(fromHex(entries)).find((entry) => toHex(entry.passkeyPublicKey) === passkeyPublicKey.toLowerCase()) ?? null
  );
}
