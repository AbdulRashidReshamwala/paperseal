import type { ExamRegistry } from '@paperseal/chain';
import { decodeApprovedList, fromHex, toHex, type ApprovedListEntry, type Hex } from '@paperseal/protocol';

import { loadCredential, type StoredCredential } from './Register';
import { examId } from './registry';

/** The key holder or centre credential Register.tsx stored in this browser for the configured exam. */
export function holderCredential(): StoredCredential | null {
  return examId ? loadCredential(examId, 'holder') : null;
}

/**
 * This credential's entry on the on-chain approved list, which carries the derived public key
 * that names its files in storage. Null before the list is posted or if the key is not on it.
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
