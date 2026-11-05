import type { ExamRegistry } from '@paperseal/chain';
import { decodeCriteria, fromHex, type Criteria, type Hex } from '@paperseal/protocol';

import { listEntryFor } from '../../shared/holder';

/** The ExamRegistry reads the centre screens share. */
export function chainReaders(registry: ExamRegistry, examId: Hex) {
  return {
    readBuild: () => registry.getBuild(examId),
    readListEntries: () => registry.getApprovedListEntries(examId),
    readCriteria: async (): Promise<Criteria | null> => {
      const encoded = await registry.getCriteria(examId);
      return encoded ? decodeCriteria(fromHex(encoded)) : null;
    },
  };
}

/** The role of a passkey on the on-chain approved list, or null if it is not listed. */
export async function roleOnList(registry: ExamRegistry, examId: Hex, passkeyPublicKey: Hex): Promise<number | null> {
  return (await listEntryFor(registry, examId, passkeyPublicKey))?.role ?? null;
}
