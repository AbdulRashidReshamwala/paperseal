import type { ExamRegistry } from '@paperseal/chain';
import { approvedListHash, criteriaHash, fromHex, toHex, type Hex } from '@paperseal/protocol';

export type CheckResult = 'pass' | 'fail' | 'absent';

export const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function criteriaMatches(encoded: Uint8Array, onChainHash: string): boolean {
  return sameHex(toHex(criteriaHash(encoded)), onChainHash);
}

export function computedListHash(examId: Hex, encoded: Uint8Array): Hex {
  return toHex(approvedListHash(fromHex(examId), encoded));
}

/** One read of the registry, shared by Overview and Commitments. Null until it is configured. */
export function loadChain(registry: ExamRegistry | null, examId: Hex | null) {
  if (!registry || !examId) return null;
  return async () => {
    const [exam, list, build, criteria, entries] = await Promise.all([
      registry.getExam(examId),
      registry.getApprovedList(examId),
      registry.getBuild(examId),
      registry.getCriteria(examId),
      registry.getApprovedListEntries(examId),
    ]);
    return { exam, list, build, criteria, entries };
  };
}

export type ChainData = Awaited<ReturnType<NonNullable<ReturnType<typeof loadChain>>>>;

/** The headline chain checks. A check is absent when the chain holds nothing to compare. */
export function chainChecks(examId: Hex | null, data: ChainData) {
  const { exam, list, build, criteria, entries } = data;
  const criteriaCheck: CheckResult =
    exam && criteria
      ? criteriaMatches(fromHex(criteria), exam.settings.criteriaHash)
        ? 'pass'
        : 'fail'
      : 'absent';
  const listCheck: CheckResult =
    examId && list && entries
      ? sameHex(computedListHash(examId, fromHex(entries)), list.listHash)
        ? 'pass'
        : 'fail'
      : 'absent';
  return { published: exam !== null, criteria: criteriaCheck, list: listCheck, build: build !== null };
}
