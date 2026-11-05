import { OnChainBytesError, type ExamRegistry } from '@paperseal/chain';
import { approvedListHash, criteriaHash, fromHex, toHex, type Hex } from '@paperseal/protocol';

export type CheckResult = 'pass' | 'fail' | 'absent';

export const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function criteriaMatches(encoded: Uint8Array, onChainHash: string): boolean {
  return sameHex(toHex(criteriaHash(encoded)), onChainHash);
}

export function computedListHash(examId: Hex, encoded: Uint8Array): Hex {
  return toHex(approvedListHash(fromHex(examId), encoded));
}

/**
 * Why a record's bytes are not usable. `unreadable`: the record is on-chain but the RPC returned no
 * event for it, which is not the same as nothing being posted. `mismatch`: the bytes read do not
 * hash to what the chain stores, so they are not shown or used.
 */
export interface ChainProblem {
  kind: 'unreadable' | 'mismatch';
  message: string;
}

export interface ChainProblems {
  criteria?: ChainProblem;
  list?: ChainProblem;
}

export interface ChainData {
  exam: Awaited<ReturnType<ExamRegistry['getExam']>>;
  list: Awaited<ReturnType<ExamRegistry['getApprovedList']>>;
  build: Awaited<ReturnType<ExamRegistry['getBuild']>>;
  /** `abi.encode(Criteria)`, hashed against `criteriaHash` by the chain client. Null if absent or unusable. */
  criteria: Hex | null;
  /** `abi.encode(Entry[])`, hashed against `listHash` by the chain client. Null if absent or unusable. */
  entries: Hex | null;
  problems?: ChainProblems;
}

async function readBytes(read: () => Promise<Hex | null>): Promise<{ value: Hex | null; problem?: ChainProblem }> {
  try {
    return { value: await read() };
  } catch (error) {
    if (!(error instanceof OnChainBytesError)) throw error;
    return { value: null, problem: { kind: error.kind === 'missing' ? 'unreadable' : 'mismatch', message: error.message } };
  }
}

/** One read of the registry, shared by Overview and Commitments. Null until it is configured. */
export function loadChain(registry: ExamRegistry | null, examId: Hex | null) {
  if (!registry || !examId) return null;
  return async (): Promise<ChainData> => {
    const [exam, list, build, criteria, entries] = await Promise.all([
      registry.getExam(examId),
      registry.getApprovedList(examId),
      registry.getBuild(examId),
      readBytes(() => registry.getCriteria(examId)),
      readBytes(() => registry.getApprovedListEntries(examId)),
    ]);
    const problems: ChainProblems = {
      ...(criteria.problem ? { criteria: criteria.problem } : {}),
      ...(entries.problem ? { list: entries.problem } : {}),
    };
    return {
      exam,
      list,
      build,
      criteria: criteria.value,
      entries: entries.value,
      ...(Object.keys(problems).length > 0 ? { problems } : {}),
    };
  };
}

/** The headline chain checks. A check is absent when the chain holds nothing to compare. */
export function chainChecks(examId: Hex | null, data: ChainData) {
  const { exam, list, build, criteria, entries, problems } = data;
  const criteriaCheck: CheckResult =
    problems?.criteria?.kind === 'mismatch'
      ? 'fail'
      : exam && criteria
      ? criteriaMatches(fromHex(criteria), exam.settings.criteriaHash)
        ? 'pass'
        : 'fail'
      : 'absent';
  const listCheck: CheckResult =
    problems?.list?.kind === 'mismatch'
      ? 'fail'
      : examId && list && entries
      ? sameHex(computedListHash(examId, fromHex(entries)), list.listHash)
        ? 'pass'
        : 'fail'
      : 'absent';
  return { published: exam !== null, criteria: criteriaCheck, list: listCheck, build: build !== null };
}
