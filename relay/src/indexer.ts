import { arkiv, type ArkivWriter, type ExamIndexInput, type ExamStage } from '@paperseal/arkiv';
import { OnChainBytesError, type ExamNameResult, type ExamRegistry, type ScannedExam } from '@paperseal/chain';
import { decodeApprovedList, fromHex } from '@paperseal/protocol';
import { isAddressEqual, type Address, type Hash, type Hex } from 'viem';

import type { IndexTarget } from './args';
import { errorText } from './output';

/*
 * `index`: the exam index of spec/arkiv.md "Exam Index". It copies what ExamRegistry's events
 * already publish: one `exam` row per exam, and one `participant` row per approved-list entry,
 * plus an exam's ENS name once that name passes every check of "Exam Names" in spec/api.md and
 * resolves to this exam and registry. Readers check every row against Sepolia, so the index only
 * helps people find exams.
 *
 * What a run has seen is kept in memory, so with `--every` a later event builds on earlier ones and
 * an exam's stage never moves back (the writer refuses that too). A write that fails is tried again
 * on the next pass, even with no new event.
 */

export type IndexRegistry = Pick<ExamRegistry, 'scanEvents' | 'getExam' | 'getApprovedList' | 'getApprovedListEntries' | 'board'>;
export type IndexWriter = Pick<ArkivWriter, 'address' | 'upsertExam' | 'mirrorParticipants'>;

export interface IndexDeps {
  registry: IndexRegistry;
  writer: IndexWriter;
  /** `resolveExamName` from @paperseal/chain, bound to the Sepolia RPC. */
  resolveName: (name: string) => Promise<ExamNameResult>;
  /** `chain.chainId` in spec/constants.json. */
  chainId: number;
  /** Blocks per `eth_getLogs`. Defaults to `logChunkBlocks` in spec/arkiv.json. */
  chunk?: number;
}

/** Where an exam's `ExamCreated` columns came from. */
interface Created {
  examStart: bigint;
  createdBlock: bigint;
  criteriaHash: Hex;
}

/** What this run knows about one exam. */
interface KnownExam {
  /** Every event seen for the exam so far in this run, merged across passes. */
  events: ScannedExam;
  /** From `ExamCreated`, or from `getExam` when that event came before the first block scanned. */
  created?: Created;
  /** From the `getApprovedList` record, when `ApprovedListPosted` came before the first block scanned. */
  listHash?: Hex;
  /** The last input this run wrote, or undefined if it hasn't written one. */
  written?: ExamIndexInput;
  /** `pending` until this writer's participant rows are all on Arkiv, or the list fails the rules. */
  participants: 'pending' | 'done' | 'refused';
}

export interface IndexState {
  /** The first block of the next scan. */
  nextBlock: bigint;
  board?: Address;
  exams: Map<string, KnownExam>;
}

export const newIndexState = (fromBlock: bigint): IndexState => ({ nextBlock: fromBlock, exams: new Map() });

export interface ParticipantsOutcome {
  /**
   * `none`: no approved list yet. `done`: written in an earlier pass. `mirrored`: this pass wrote
   * what was missing. `refused`: the list fails the rules, so nothing is written for it. `failed`:
   * a read or write failed, and the next pass tries again.
   */
  result: 'none' | 'done' | 'mirrored' | 'refused' | 'failed';
  written: number;
  skipped: number;
  txHashes: Hash[];
  detail?: string;
}

export interface ExamOutcome {
  examId: Hex;
  /** `held`: not written this pass, so a check that couldn't run doesn't clear a column. */
  action: 'created' | 'patched' | 'unchanged' | 'failed' | 'held';
  input?: ExamIndexInput;
  entityKey?: Hex;
  txHash?: Hash;
  detail?: string;
  participants: ParticipantsOutcome;
}

export interface IndexReport {
  at: Date;
  fromBlock: bigint;
  toBlock: bigint;
  outcomes: ExamOutcome[];
  /** One line per name, saying whether it was used and why not. */
  names: string[];
  notes: string[];
}

/** Adds one scan's events to what the run already knows. Each event happens once per exam. */
function merge(known: KnownExam, scanned: ScannedExam): void {
  const events = known.events;
  if (!events.created && scanned.created) events.created = scanned.created;
  if (!events.list && scanned.list) events.list = scanned.list;
  if (!events.build && scanned.build) events.build = scanned.build;
}

/**
 * The full row for one exam, from its events. `ExamCreated` before the scanned range is filled in
 * from `getExam`, and `ApprovedListPosted` before it from `getApprovedList`; both are cached, so
 * each is read once per run. The stage is the furthest event seen, so it never moves back.
 */
export async function examInput(
  known: KnownExam,
  registry: Pick<IndexRegistry, 'getExam' | 'getApprovedList'>,
  context: { registry: Address; board: Address; chainId: number; name: string | null },
): Promise<ExamIndexInput> {
  const { events } = known;
  const examId = events.examId;
  if (!known.created) {
    if (events.created) {
      known.created = { examStart: events.created.examStart, createdBlock: events.created.block, criteriaHash: events.created.criteriaHash };
    } else {
      const exam = await registry.getExam(examId);
      if (!exam) throw new Error(`the registry's events name exam ${examId}, but getExam has no such exam`);
      known.created = { examStart: exam.settings.examStart, createdBlock: exam.createdBlock, criteriaHash: exam.settings.criteriaHash };
    }
  }
  const stage: ExamStage = events.build ? 'built' : events.list ? 'listed' : 'published';
  let approvedListHash: Hex | null = events.list?.listHash ?? known.listHash ?? null;
  if (approvedListHash === null && stage !== 'published') {
    const list = await registry.getApprovedList(examId);
    if (!list) throw new Error(`exam ${examId} has a BuildPosted event, but getApprovedList has no list`);
    known.listHash = list.listHash;
    approvedListHash = list.listHash;
  }
  return {
    examId,
    registry: context.registry,
    board: context.board,
    chainId: context.chainId,
    stage,
    examStart: known.created.examStart,
    createdBlock: known.created.createdBlock,
    criteriaHash: known.created.criteriaHash,
    approvedListHash,
    paperHash: events.build?.paperHash ?? null,
    name: context.name,
  };
}

/** What the names say this pass: the verified name per exam ID, and exam IDs whose name couldn't be read. */
export interface NameCheck {
  byExam: Map<string, string>;
  /** A name the RPC couldn't answer for decides nothing, so its exam keeps the name it had. */
  unreadable: Map<string, string>;
  lines: string[];
}

/**
 * Runs every check of "Exam Names" for each name. A name is used only if it passes, its `addr` is
 * `registry`, and it resolves to an exam ID; which exam it names is matched per exam later.
 */
export async function checkNames(names: readonly string[], registry: Address, resolve: IndexDeps['resolveName']): Promise<NameCheck> {
  const check: NameCheck = { byExam: new Map(), unreadable: new Map(), lines: [] };
  for (const name of names) {
    let result: ExamNameResult;
    try {
      result = await resolve(name);
    } catch (error) {
      result = { ok: false, failed: 'unreadable', reason: errorText(error), partial: {} };
    }
    if (!result.ok) {
      const examId = result.partial.examId?.toLowerCase();
      if (result.failed === 'unreadable' && examId) check.unreadable.set(examId, name);
      check.lines.push(`skipped ${name}: failed the ${result.failed} check: ${result.reason}`);
      continue;
    }
    const { value } = result;
    if (!isAddressEqual(value.registry, registry)) {
      check.lines.push(`skipped ${name}: it points to registry ${value.registry}, not ${registry}`);
      continue;
    }
    const examId = value.examId.toLowerCase();
    const taken = check.byExam.get(examId);
    if (taken !== undefined) {
      check.lines.push(`skipped ${name}: ${taken} already names exam ${examId}`);
      continue;
    }
    check.byExam.set(examId, name);
    check.lines.push(`checked ${name}: exam ${examId}`);
  }
  return check;
}

/** Reads the list bytes (already hashed against the list hash), decodes them as every reader does, and writes the rows. */
async function mirrorList(known: KnownExam, target: IndexTarget, deps: IndexDeps): Promise<ParticipantsOutcome> {
  const none = { written: 0, skipped: 0, txHashes: [] };
  const examId = known.events.examId;
  let entries: Hex | null;
  try {
    entries = known.events.list?.entries ?? (await deps.registry.getApprovedListEntries(examId));
  } catch (error) {
    if (error instanceof OnChainBytesError && error.kind === 'mismatch') {
      known.participants = 'refused';
      return { result: 'refused', ...none, detail: `no participants written: ${errorText(error)}` };
    }
    return { result: 'failed', ...none, detail: `reading the approved list: ${errorText(error)}` };
  }
  if (entries === null) return { result: 'failed', ...none, detail: 'getApprovedList has no list yet' };
  let decoded;
  try {
    decoded = decodeApprovedList(fromHex(entries));
  } catch (error) {
    known.participants = 'refused';
    return { result: 'refused', ...none, detail: `the approved list fails the list rules, so no participants are written: ${errorText(error)}` };
  }
  try {
    const result = await deps.writer.mirrorParticipants({ examId, registry: target.registry, entries: decoded });
    known.participants = 'done';
    return { result: 'mirrored', written: result.written.length, skipped: result.skipped.length, txHashes: result.txHashes };
  } catch (error) {
    return { result: 'failed', ...none, detail: errorText(error) };
  }
}

const sameInput = (a: ExamIndexInput | undefined, b: ExamIndexInput) =>
  a !== undefined && JSON.stringify(a, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(b, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/**
 * One pass: scans from `state.nextBlock`, then writes every exam the scan touched, every exam whose
 * write failed before, and every exam whose verified name changed. Throws only if the board or the
 * scan can't be read, leaving `state` to try the same range again.
 */
export async function indexPass(target: IndexTarget, deps: IndexDeps, state: IndexState): Promise<IndexReport> {
  state.board ??= await deps.registry.board();
  const board = state.board;
  const scan = await deps.registry.scanEvents({
    fromBlock: state.nextBlock,
    ...(target.toBlock === undefined ? {} : { toBlock: target.toBlock }),
    chunk: deps.chunk ?? arkiv.logChunkBlocks,
  });
  const touched = new Set<string>();
  for (const scanned of scan.exams) {
    const key = scanned.examId.toLowerCase();
    let known = state.exams.get(key);
    if (!known) {
      known = { events: { examId: key as Hex, created: null }, participants: 'pending' };
      state.exams.set(key, known);
    }
    merge(known, scanned);
    touched.add(key);
  }
  // Never back: a --from-block past the chain's head stays where it was.
  const after = scan.toBlock + 1n;
  if (after > state.nextBlock) state.nextBlock = after;

  const names = await checkNames(target.names, target.registry, deps.resolveName);
  const report: IndexReport = { at: new Date(), fromBlock: scan.fromBlock, toBlock: scan.toBlock, outcomes: [], names: names.lines, notes: [] };
  const used = new Set<string>();

  for (const [key, known] of state.exams) {
    const examId = known.events.examId;
    const verified = names.byExam.get(key) ?? null;
    if (verified) used.add(key);
    const unreadable = names.unreadable.get(key);
    // A name that couldn't be read keeps what this run last wrote; with nothing written, the exam waits.
    if (unreadable !== undefined && verified === null && !known.written) {
      report.outcomes.push({
        examId,
        action: 'held',
        detail: `the name ${unreadable} couldn't be read, so the row isn't written without it`,
        participants: { result: 'none', written: 0, skipped: 0, txHashes: [] },
      });
      continue;
    }
    const name = verified ?? (unreadable !== undefined ? (known.written?.name ?? null) : null);
    const listPending = known.participants === 'pending' && (known.events.list !== undefined || known.events.build !== undefined);
    const nameChanged = known.written !== undefined && known.written.name !== name;
    if (!touched.has(key) && known.written && !listPending && !nameChanged) continue;

    const outcome: ExamOutcome = { examId, action: 'failed', participants: { result: 'none', written: 0, skipped: 0, txHashes: [] } };
    report.outcomes.push(outcome);
    try {
      const input = await examInput(known, deps.registry, { registry: target.registry, board, chainId: deps.chainId, name });
      outcome.input = input;
      if (sameInput(known.written, input)) {
        outcome.action = 'unchanged';
        outcome.detail = 'this run already wrote it';
      } else {
        const written = await deps.writer.upsertExam(input);
        outcome.action = written.action;
        outcome.entityKey = written.entityKey;
        if (written.txHash) outcome.txHash = written.txHash;
        known.written = input;
      }
    } catch (error) {
      outcome.detail = errorText(error);
      continue;
    }
    if (outcome.input.stage === 'published') continue;
    if (known.participants === 'done') outcome.participants = { result: 'done', written: 0, skipped: 0, txHashes: [] };
    else if (known.participants === 'refused') outcome.participants = { result: 'refused', written: 0, skipped: 0, txHashes: [], detail: 'refused in an earlier pass' };
    else outcome.participants = await mirrorList(known, target, deps);
  }

  for (const [examId, name] of names.byExam) {
    if (!used.has(examId)) report.notes.push(`${name} names exam ${examId}, which has no event in the blocks scanned so far`);
  }
  return report;
}

export function indexTally(report: IndexReport) {
  const count = (action: ExamOutcome['action']) => report.outcomes.filter((o) => o.action === action).length;
  const participants = (result: ParticipantsOutcome['result']) => report.outcomes.filter((o) => o.participants.result === result).length;
  return {
    created: count('created'),
    patched: count('patched'),
    unchanged: count('unchanged'),
    held: count('held'),
    failed: count('failed'),
    participantsWritten: report.outcomes.reduce((sum, o) => sum + o.participants.written, 0),
    participantsSkipped: report.outcomes.reduce((sum, o) => sum + o.participants.skipped, 0),
    listsRefused: participants('refused'),
    listsFailed: participants('failed'),
  };
}

interface Links {
  entity: (key: Hex) => string;
  tx: (hash: Hash) => string;
}

function participantsLine(p: ParticipantsOutcome): string {
  switch (p.result) {
    case 'none':
      return 'no approved list yet';
    case 'done':
      return 'already written in this run';
    case 'mirrored':
      return `written ${String(p.written)}, skipped ${String(p.skipped)} (already on Arkiv)`;
    case 'refused':
      return `none written: ${p.detail ?? 'refused'}`;
    case 'failed':
      return `failed, trying again next pass: ${p.detail ?? 'unknown error'}`;
  }
}

/** The lines `index` prints for one pass: names, each exam, notes, then a summary. */
export function indexReportLines(report: IndexReport, links: Links): string[] {
  const lines: string[] = [];
  for (const line of report.names) lines.push(`  name   ${line}`);
  for (const o of report.outcomes) {
    const what = o.input ? `${o.input.stage}, ${o.input.name ?? 'no name'}` : '';
    lines.push(`  exam   ${o.examId}  ${o.action}${what ? `  (${what})` : ''}${o.detail ? `: ${o.detail}` : ''}`);
    if (o.entityKey) lines.push(`         entity ${o.entityKey}  ${links.entity(o.entityKey)}`);
    if (o.txHash) lines.push(`         tx     ${o.txHash}  ${links.tx(o.txHash)}`);
    if (o.action !== 'failed' && o.action !== 'held') lines.push(`         participants ${participantsLine(o.participants)}`);
    for (const tx of o.participants.txHashes) lines.push(`         tx     ${tx}  ${links.tx(tx)}`);
  }
  for (const note of report.notes) lines.push(`  note   ${note}`);
  const t = indexTally(report);
  lines.push(
    `[${report.at.toISOString()}] blocks ${report.fromBlock.toString()}-${report.toBlock.toString()}: ${String(report.outcomes.length)} exam${report.outcomes.length === 1 ? '' : 's'}, ` +
      `created ${String(t.created)}, patched ${String(t.patched)}, unchanged ${String(t.unchanged)}, held ${String(t.held)}, failed ${String(t.failed)}; ` +
      `participants written ${String(t.participantsWritten)}, skipped ${String(t.participantsSkipped)}; lists refused ${String(t.listsRefused)}, failed ${String(t.listsFailed)}`,
  );
  return lines;
}

export interface LoopDeps extends IndexDeps {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  onReport: (report: IndexReport) => void;
  onError: (message: string) => void;
}

/** `index --every`: a pass, then the next from the last block scanned + 1, until Ctrl+C. One pass without `everySeconds`. */
export async function indexLoop(target: IndexTarget, deps: LoopDeps, state: IndexState = newIndexState(target.fromBlock)): Promise<IndexState> {
  while (!deps.signal.aborted) {
    try {
      deps.onReport(await indexPass(target, deps, state));
    } catch (error) {
      deps.onError(`pass failed, trying blocks from ${state.nextBlock.toString()} again: ${errorText(error)}`);
    }
    if (target.everySeconds === undefined || deps.signal.aborted) break;
    await deps.sleep(target.everySeconds * 1000, deps.signal);
  }
  return state;
}

/**
 * The RPC URL as printed: its origin, with any credentials, path or query hidden, since providers
 * put keys there. `secrets` are what main registers, because viem quotes the URL in its errors.
 */
export function rpcLabel(rpcUrl: string): { shown: string; secrets: string[] } {
  const url = new URL(rpcUrl);
  const rest = `${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`;
  if (rest === '' && url.username === '' && url.password === '') return { shown: url.origin, secrets: [] };
  return { shown: `${url.origin}/[redacted]`, secrets: [rpcUrl, ...(rest === '' ? [] : [rest])] };
}
