import { OnChainBytesError, type ExamRegistry } from '@paperseal/chain';
import {
  decodeApprovedList,
  decodeCriteria,
  fromHex,
  type ApprovedListEntry,
  type Criteria,
  type Hex,
} from '@paperseal/protocol';
import type { OutboxMessage, StatusResponse, TeeClient } from '@paperseal/tee-client';

/*
 * What the board's screen is decided from: the exam, list and Build on ExamRegistry, then the
 * TEE's status and outbox. ExamRegistry is write-once, so a value read successfully isn't read again.
 */

/**
 * The on-chain list: its hash, and the posted bytes decoded. `getApprovedListEntries` hashes the
 * bytes against `listHash`, so a list whose bytes can't be read or don't match is reported as that,
 * which is not the same as no list being posted.
 */
export async function readApprovedList(registry: ExamRegistry, id: Hex) {
  const list = await registry.getApprovedList(id);
  if (!list) return null;
  let entries: ApprovedListEntry[] = [];
  let problem: string | null = null;
  try {
    const encoded = await registry.getApprovedListEntries(id);
    if (!encoded) {
      problem = 'The list is posted on-chain, but its entries could not be read.';
    } else {
      entries = decodeApprovedList(fromHex(encoded));
    }
  } catch (error) {
    problem =
      error instanceof OnChainBytesError
        ? error.kind === 'missing'
          ? `The list hash is on-chain, but the list's bytes could not be read from the RPC. This is not an empty list: ${error.message} Try another RPC.`
          : `The list's bytes read from the RPC do not match the hash on-chain, so they are not shown. ${error.message}`
        : `The posted entries are malformed: ${(error as Error).message}`;
  }
  return { list, entries, problem };
}

/** The exam and its full criteria, both from ExamRegistry. `getCriteria` has checked them against `criteriaHash`. */
export async function readExam(registry: ExamRegistry, id: Hex) {
  const exam = await registry.getExam(id);
  if (!exam) return null;
  let criteria: Criteria | null = null;
  let criteriaProblem: string | null = null;
  try {
    const encoded = await registry.getCriteria(id);
    if (encoded) criteria = decodeCriteria(fromHex(encoded));
  } catch (error) {
    criteriaProblem =
      error instanceof OnChainBytesError
        ? `The criteria could not be shown: ${error.message}`
        : `The criteria on-chain are malformed: ${(error as Error).message}`;
  }
  return { exam, criteria, criteriaProblem };
}

export type ExamRead = NonNullable<Awaited<ReturnType<typeof readExam>>>;
export type ListRead = NonNullable<Awaited<ReturnType<typeof readApprovedList>>>;
export type BuildRead = NonNullable<Awaited<ReturnType<ExamRegistry['getBuild']>>>;

export interface Snapshot {
  found: ExamRead | null;
  list: ListRead | null;
  build: BuildRead | null;
  status: StatusResponse | null;
  /** Why the TEE's status could not be read. */
  teeProblem: string | null;
  outbox: readonly OutboxMessage[];
}

export async function readSnapshot(
  input: { registry: ExamRegistry; tee: Pick<TeeClient, 'status' | 'outbox'> | null; examId: Hex },
  previous: Snapshot | null,
): Promise<Snapshot> {
  const { registry, tee, examId } = input;
  const found = previous?.found && !previous.found.criteriaProblem ? previous.found : await readExam(registry, examId);
  const empty: Snapshot = { found, list: null, build: null, status: null, teeProblem: null, outbox: [] };
  if (!found) return empty;
  const list = previous?.list && !previous.list.problem ? previous.list : await readApprovedList(registry, examId);
  const build = previous?.build ?? (list ? await registry.getBuild(examId) : null);
  if (!tee) return { ...empty, list, build, teeProblem: 'The sealed machine is not connected.' };
  try {
    const status = await tee.status();
    const outbox = list && !build ? (await tee.outbox()).messages : [];
    return { ...empty, list, build, status, outbox };
  } catch (error) {
    return { ...empty, list, build, teeProblem: error instanceof Error ? error.message : String(error) };
  }
}

export type ExamStep = 'draft' | 'people' | 'wait' | 'post-build' | 'status';

/** The one screen an exam's state calls for. */
export function decideStep(snapshot: Snapshot): ExamStep {
  if (!snapshot.found) return 'draft';
  if (!snapshot.list) return 'people';
  if (snapshot.build) return 'status';
  return snapshot.outbox.length > 0 ? 'post-build' : 'wait';
}
