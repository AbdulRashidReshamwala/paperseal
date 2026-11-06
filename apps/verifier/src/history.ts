import { participantRoles, type ArkivReader, type ExamRow, type ParticipantRow } from '@paperseal/arkiv';
import { OnChainBytesError, type ExamNameResult, type ExamRegistry } from '@paperseal/chain';
import { ApprovedListError, decodeApprovedList, fromHex, type Hex } from '@paperseal/protocol';
import { isAddressEqual, sha256, type Address } from 'viem';

import { sameHex } from './checks';
import { roleNames } from './custody';
import { isExamId } from './settings';

/*
 * The exam history, from "Exam Index" in spec/arkiv.md, "Reading". The index only helps people find
 * exams: every row is checked against the registry before it is shown, and a name only after it
 * passes "Exam Names" again.
 */

/** What the history reads from Arkiv. */
export type HistoryReader = Pick<ArkivReader, 'examRows' | 'participantRows'>;
/** What the history reads from the registry, through the viewer's own RPC. */
export type HistoryRegistry = Pick<ExamRegistry, 'address' | 'getExam' | 'getApprovedList' | 'getBuild' | 'getApprovedListEntries'>;
/** "Exam Names" in spec/api.md, run in full. */
export type NameCheck = (name: string) => Promise<ExamNameResult>;

export type ExamStage = 'published' | 'listed' | 'built';
const stageRank: Record<ExamStage, number> = { published: 0, listed: 1, built: 2 };
/** A stage this reader doesn't know is behind every stage it does. */
const rankOf = (stage: string): number => (Object.hasOwn(stageRank, stage) ? stageRank[stage as ExamStage] : -1);

export interface HistoryExam {
  examId: Hex;
  /** From the registry. */
  examStart: bigint;
  /** The stage the registry shows, never the row's. */
  stage: ExamStage;
  /** No matching row has reached the stage the registry shows. */
  behind: boolean;
  /** Set only when the name passed every check again and resolves to this exam and registry. */
  name: string | null;
  /** The writers whose rows matched the registry. */
  writers: Address[];
}

export interface IgnoredExamRows {
  /** Rows for an exam the registry doesn't have. */
  notOnChain: number;
  /** Rows whose `examStart` or `criteriaHash` differ from the registry's. */
  differs: number;
  /** Rows whose exam ID isn't one, or that name another registry. */
  malformed: number;
  /** Names that failed the name check, or resolve to another exam or registry. */
  names: number;
}

/**
 * An exam whose registry reads failed, often because a public RPC limits how fast it answers.
 * Nothing about it is verified, so no stage, start or name is claimed, and it is not a failure.
 */
export interface UnreadExam {
  examId: Hex;
  /** Why the read failed, for a folded details area. */
  reason: string;
}

export interface ExamHistory {
  /** Newest `examStart` first. */
  exams: HistoryExam[];
  /** By exam ID. Kept apart from `ignored`: these may be fine, and reading again may show them. */
  unread: UnreadExam[];
  /** Every row read, ignored ones included. */
  rows: number;
  ignored: IgnoredExamRows;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const byId = <T extends { examId: Hex }>(a: T, b: T) => (a.examId < b.examId ? -1 : a.examId > b.examId ? 1 : 0);

/** Runs `task` on every item, at most `limit` at a time, so a long list doesn't flood the RPC. */
export async function eachLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await task(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The first of `names` that passes the name check and resolves to this exam in this registry. */
export async function verifiedName(
  names: readonly string[],
  examId: Hex,
  registry: Address,
  checkName: NameCheck,
  ignored: IgnoredExamRows,
): Promise<string | null> {
  for (const name of names) {
    let result: ExamNameResult;
    try {
      result = await checkName(name);
    } catch {
      ignored.names += 1;
      continue;
    }
    if (result.ok && sameHex(result.value.examId, examId) && isAddressEqual(result.value.registry, registry)) return name;
    ignored.names += 1;
  }
  return null;
}

const READS_AT_ONCE = 4;

/**
 * The registry's exams that `writers` have indexed, each checked against the registry: shown only
 * if `getExam` has it with the same `examStart` and `criteriaHash`, at the stage the registry shows.
 * With no writers nothing is read.
 */
export async function loadExamHistory(args: {
  reader: HistoryReader;
  registry: HistoryRegistry;
  writers: readonly Address[];
  checkName: NameCheck;
}): Promise<ExamHistory> {
  const { reader, registry, writers, checkName } = args;
  const ignored: IgnoredExamRows = { notOnChain: 0, differs: 0, malformed: 0, names: 0 };
  if (writers.length === 0) return { exams: [], unread: [], rows: 0, ignored };
  const rows = await reader.examRows(registry.address, writers);

  const byExam = new Map<Hex, ExamRow[]>();
  for (const row of rows) {
    if (!isExamId(row.examId) || !isAddressEqual(row.registry, registry.address)) {
      ignored.malformed += 1;
      continue;
    }
    const id = row.examId as Hex;
    byExam.set(id, [...(byExam.get(id) ?? []), row]);
  }

  const unread: UnreadExam[] = [];
  const checked = await eachLimited([...byExam], READS_AT_ONCE, async ([examId, examRows]): Promise<HistoryExam | null> => {
    // One exam whose reads fail is shown as not read yet, and never stops the others.
    let reads;
    try {
      reads = await Promise.all([registry.getExam(examId), registry.getApprovedList(examId), registry.getBuild(examId)]);
    } catch (error) {
      unread.push({ examId, reason: reasonOf(error) });
      return null;
    }
    const [exam, list, build] = reads;
    if (!exam) {
      ignored.notOnChain += examRows.length;
      return null;
    }
    const matching = examRows.filter(
      (row) => row.examStart === exam.settings.examStart && sameHex(row.criteriaHash, exam.settings.criteriaHash),
    );
    ignored.differs += examRows.length - matching.length;
    if (matching.length === 0) return null;
    const stage: ExamStage = build ? 'built' : list ? 'listed' : 'published';
    const furthest = Math.max(...matching.map((row) => rankOf(row.stage)));
    const names = [...new Set(matching.map((row) => row.name).filter((name) => name !== ''))];
    return {
      examId,
      examStart: exam.settings.examStart,
      stage,
      behind: furthest < stageRank[stage],
      name: await verifiedName(names, examId, registry.address, checkName, ignored),
      writers: [...new Set(matching.map((row) => row.creator))],
    };
  });

  const exams = checked
    .filter((exam): exam is HistoryExam => exam !== null)
    .sort((a, b) => (a.examStart === b.examStart ? (a.examId < b.examId ? -1 : 1) : a.examStart > b.examStart ? -1 : 1));
  return { exams, unread: unread.sort(byId), rows: rows.length, ignored };
}

/** The role column in plain words, as the rest of the page says it. */
export function roleWords(role: string): string {
  const number = Object.entries(participantRoles).find(([, column]) => column === role)?.[0];
  return (number === undefined ? undefined : roleNames[Number(number)]) ?? 'Unknown role';
}

export interface ParticipantExam {
  examId: Hex;
  /** The role column, which matched the entry on the registry's list. */
  role: string;
  examStart: bigint | null;
}

export interface IgnoredParticipantRows {
  /** Rows with no matching entry on the exam's approved list on the registry, or no list at all. */
  notOnList: number;
  /** Rows for an exam whose list on the registry doesn't hash to its record, or breaks the list rules. */
  badList: number;
  /** Rows whose exam ID isn't one, or for another registry or owner. */
  malformed: number;
}

export interface ParticipantSearch {
  /** Newest `examStart` first. */
  exams: ParticipantExam[];
  /** Exams whose approved list could not be read yet, so the entry is not checked. By exam ID. */
  unchecked: UnreadExam[];
  rows: number;
  ignored: IgnoredParticipantRows;
}

type Listed = { role: string | undefined; owner: string; passkeyKeyHash: string }[];

/**
 * The entries of an exam's approved list on the registry, as the rows name them, or null before a
 * list is posted. `bad`: the bytes differ from the record or break the list rules. `unread`: the RPC
 * didn't answer, or returned no event for the record, which decides nothing.
 */
async function listedEntries(
  registry: HistoryRegistry,
  examId: Hex,
): Promise<Listed | null | { bad: true } | { unread: string }> {
  let encoded: Hex | null;
  try {
    encoded = await registry.getApprovedListEntries(examId);
  } catch (error) {
    if (error instanceof OnChainBytesError && error.kind === 'mismatch') return { bad: true };
    return { unread: reasonOf(error) };
  }
  if (encoded === null) return null;
  try {
    return decodeApprovedList(fromHex(encoded)).map((entry) => ({
      role: participantRoles[entry.role],
      owner: entry.owner,
      passkeyKeyHash: sha256(entry.passkeyPublicKey).toLowerCase(),
    }));
  } catch (error) {
    if (error instanceof ApprovedListError) return { bad: true };
    throw error;
  }
}

/**
 * The exams whose approved list holds `owner`, exactly as typed, as `writers` indexed them. An exam
 * is listed only if the registry's own list, read by `getApprovedListEntries` and checked against
 * its hash there, has an entry with the row's passkey, owner and role.
 */
export async function findParticipant(args: {
  reader: HistoryReader;
  registry: HistoryRegistry;
  writers: readonly Address[];
  owner: string;
}): Promise<ParticipantSearch> {
  const { reader, registry, writers, owner } = args;
  const ignored: IgnoredParticipantRows = { notOnList: 0, badList: 0, malformed: 0 };
  if (writers.length === 0 || owner === '') return { exams: [], unchecked: [], rows: 0, ignored };
  const rows = await reader.participantRows({ registry: registry.address, owner }, writers);

  const byExam = new Map<Hex, ParticipantRow[]>();
  for (const row of rows) {
    if (!isExamId(row.examId) || !isAddressEqual(row.registry, registry.address) || row.owner !== owner) {
      ignored.malformed += 1;
      continue;
    }
    const id = row.examId as Hex;
    byExam.set(id, [...(byExam.get(id) ?? []), row]);
  }

  const unchecked: UnreadExam[] = [];
  const found = await eachLimited([...byExam], READS_AT_ONCE, async ([examId, examRows]): Promise<ParticipantExam[]> => {
    const entries = await listedEntries(registry, examId);
    if (entries !== null && 'unread' in entries) {
      unchecked.push({ examId, reason: entries.unread });
      return [];
    }
    if (entries !== null && 'bad' in entries) {
      ignored.badList += examRows.length;
      return [];
    }
    const roles = new Set<string>();
    for (const row of examRows) {
      const listed = entries?.some(
        (entry) => entry.passkeyKeyHash === row.passkeyKeyHash.toLowerCase() && entry.owner === row.owner && entry.role === row.role,
      );
      if (listed) roles.add(row.role);
      else ignored.notOnList += 1;
    }
    if (roles.size === 0) return [];
    // The entry is already checked; the start time only helps sort, so a failed read leaves it out.
    const examStart = await registry.getExam(examId).then(
      (exam) => exam?.settings.examStart ?? null,
      () => null,
    );
    return [...roles].map((role) => ({ examId, role, examStart }));
  });

  const start = (exam: ParticipantExam) => exam.examStart ?? -1n;
  const exams = found
    .flat()
    .sort((a, b) => (start(a) === start(b) ? (a.examId < b.examId ? -1 : 1) : start(a) > start(b) ? -1 : 1));
  return { exams, unchecked: unchecked.sort(byId), rows: rows.length, ignored };
}
