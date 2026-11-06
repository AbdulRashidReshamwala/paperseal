import type { ExamRow, ParticipantRow } from '@paperseal/arkiv';
import { OnChainBytesError, type ExamNameResult, type ResolvedExamName } from '@paperseal/chain';
import { encodeApprovedList, roundTimeSeconds, toHex, type ApprovedListEntry, type Hex } from '@paperseal/protocol';
import { sha256, type Address } from 'viem';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { approvedList, registryAddress } from '@paperseal/verify/fixtures';
import { examStatus, findParticipant, loadExamHistory, roleWords, type HistoryReader, type HistoryRegistry } from './history';

/*
 * The Arkiv reader and the registry are the two things stubbed here. Approved lists are real
 * encodings, decoded and checked by the same code the rest of the page uses.
 */

const writer: Address = '0x1111111111111111111111111111111111111111';
const otherRegistry: Address = '0x00000000000000000000000000000000000000bb';
const idOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const criteriaOf = (n: number): Hex => `0x${n.toString(16).padStart(64, 'c')}`;

interface OnChain {
  examStart: bigint;
  criteriaHash: Hex;
  list?: boolean;
  build?: boolean;
  entries?: ApprovedListEntry[];
}

function registryOf(exams: Record<Hex, OnChain>, over: Partial<HistoryRegistry> = {}) {
  const at = (examId: Hex) => exams[examId.toLowerCase() as Hex];
  return {
    address: registryAddress,
    getExam: vi.fn((examId: Hex) => {
      const exam = at(examId);
      return Promise.resolve(exam ? { createdAt: 1n, createdBlock: 1n, settings: { examStart: exam.examStart, criteriaHash: exam.criteriaHash } } : null);
    }),
    getApprovedList: vi.fn((examId: Hex) => Promise.resolve(at(examId)?.list ? { listHash: '0x', postedAt: 1n, postedBlock: 1n } : null)),
    getBuild: vi.fn((examId: Hex) => Promise.resolve(at(examId)?.build ? { paperHash: '0x', postedAt: 1n } : null)),
    getApprovedListEntries: vi.fn((examId: Hex) => {
      const entries = at(examId)?.entries;
      return Promise.resolve(entries ? toHex(encodeApprovedList(entries)) : null);
    }),
    ...over,
  } as unknown as HistoryRegistry & { getExam: Mock<HistoryRegistry['getExam']> };
}

function examRow(n: number, over: Partial<ExamRow> = {}): ExamRow {
  return {
    entityKey: idOf(1000 + n),
    creator: writer,
    createdAtBlock: 1n,
    examId: idOf(n),
    registry: registryAddress,
    board: writer,
    chainId: 11155111n,
    stage: 'published',
    examStart: BigInt(1_900_000_000 + n),
    createdBlock: 1n,
    criteriaHash: criteriaOf(n),
    approvedListHash: '',
    paperHash: '',
    name: '',
    ...over,
  };
}

const onChain = (n: number, over: Partial<OnChain> = {}): OnChain => ({ examStart: BigInt(1_900_000_000 + n), criteriaHash: criteriaOf(n), ...over });

function readerOf(exams: ExamRow[], participants: ParticipantRow[] = []) {
  return {
    examRows: vi.fn(() => Promise.resolve(exams)),
    participantRows: vi.fn(() => Promise.resolve(participants)),
  } satisfies HistoryReader;
}

const resolved = (name: string, examId: Hex, registry: Address = registryAddress): ExamNameResult => ({
  ok: true,
  value: { name, examId, registry } as ResolvedExamName,
});
const noNames = () => Promise.reject(new Error('no name check expected'));

describe('the exam history', () => {
  it('asks only for this registry, from the writers given, and shows verified exams newest first', async () => {
    const reader = readerOf([examRow(1), examRow(3), examRow(2)]);
    const registry = registryOf({ [idOf(1)]: onChain(1), [idOf(2)]: onChain(2), [idOf(3)]: onChain(3) });
    const history = await loadExamHistory({ reader, registry, writers: [writer], checkName: noNames });
    expect(reader.examRows).toHaveBeenCalledWith(registryAddress, [writer]);
    expect(history.exams.map((exam) => exam.examId)).toEqual([idOf(3), idOf(2), idOf(1)]);
    expect(history.exams[0]).toMatchObject({ stage: 'published', behind: false, name: null, writers: [writer] });
    expect(history.ignored).toEqual({ notOnChain: 0, differs: 0, malformed: 0, names: 0 });
  });

  it('ignores and counts rows whose start time or criteria differ from the registry', async () => {
    const reader = readerOf([examRow(1, { examStart: 5n }), examRow(2, { criteriaHash: criteriaOf(9) }), examRow(3)]);
    const registry = registryOf({ [idOf(1)]: onChain(1), [idOf(2)]: onChain(2), [idOf(3)]: onChain(3) });
    const history = await loadExamHistory({ reader, registry, writers: [writer], checkName: noNames });
    expect(history.exams.map((exam) => exam.examId)).toEqual([idOf(3)]);
    expect(history.ignored.differs).toBe(2);
  });

  it('ignores and counts rows for exams that are not on the registry, or are malformed', async () => {
    const reader = readerOf([examRow(1), examRow(2), examRow(4, { examId: 'nope' }), examRow(5, { registry: otherRegistry })]);
    const registry = registryOf({ [idOf(2)]: onChain(2) });
    const history = await loadExamHistory({ reader, registry, writers: [writer], checkName: noNames });
    expect(history.exams.map((exam) => exam.examId)).toEqual([idOf(2)]);
    expect(history.ignored).toMatchObject({ notOnChain: 1, malformed: 2 });
    expect(history.rows).toBe(4);
  });

  it("shows the registry's stage, and says when the row is behind", async () => {
    const reader = readerOf([examRow(1, { stage: 'listed' }), examRow(2, { stage: 'built' }), examRow(3, { stage: 'listed' })]);
    const registry = registryOf({
      [idOf(1)]: onChain(1, { list: true, build: true }),
      [idOf(2)]: onChain(2, { list: true, build: true }),
      [idOf(3)]: onChain(3, { list: true }),
    });
    const history = await loadExamHistory({ reader, registry, writers: [writer], checkName: noNames });
    const byId = new Map(history.exams.map((exam) => [exam.examId, exam]));
    expect(byId.get(idOf(1))).toMatchObject({ stage: 'built', behind: true });
    expect(byId.get(idOf(2))).toMatchObject({ stage: 'built', behind: false });
    expect(byId.get(idOf(3))).toMatchObject({ stage: 'listed', behind: false });
  });

  it('never shows a stage ahead of the registry, whatever the row says', async () => {
    const reader = readerOf([examRow(1, { stage: 'built' })]);
    const history = await loadExamHistory({ reader, registry: registryOf({ [idOf(1)]: onChain(1) }), writers: [writer], checkName: noNames });
    expect(history.exams[0]).toMatchObject({ stage: 'published', behind: false });
  });

  it('shows a name only once it passes again and resolves to this exam in this registry', async () => {
    const reader = readerOf([
      examRow(1, { name: 'good.board.eth' }),
      examRow(2, { name: 'failing.board.eth' }),
      examRow(3, { name: 'elsewhere.board.eth' }),
      examRow(4, { name: 'other-registry.board.eth' }),
      examRow(5, { name: 'unreadable.board.eth' }),
    ]);
    const registry = registryOf(Object.fromEntries([1, 2, 3, 4, 5].map((n) => [idOf(n), onChain(n)])));
    const checkName = vi.fn((name: string): Promise<ExamNameResult> => {
      if (name === 'good.board.eth') return Promise.resolve(resolved(name, idOf(1)));
      if (name === 'elsewhere.board.eth') return Promise.resolve(resolved(name, idOf(9)));
      if (name === 'other-registry.board.eth') return Promise.resolve(resolved(name, idOf(4), otherRegistry));
      if (name === 'unreadable.board.eth') return Promise.reject(new Error('RPC down'));
      return Promise.resolve({ ok: false, failed: 'primaryName', reason: 'differs', partial: {} });
    });
    const history = await loadExamHistory({ reader, registry, writers: [writer], checkName });
    const byId = new Map(history.exams.map((exam) => [exam.examId, exam]));
    expect(byId.get(idOf(1))?.name).toBe('good.board.eth');
    for (const n of [2, 3, 4, 5]) expect(byId.get(idOf(n))?.name).toBeNull();
    expect(history.ignored.names).toBe(4);
    expect(checkName).toHaveBeenCalledTimes(5);
  });

  it('shows an exam two writers indexed once, and checks no name a mismatched row carries', async () => {
    const second: Address = '0x2222222222222222222222222222222222222222';
    const reader = readerOf([examRow(1), examRow(1, { creator: second, entityKey: idOf(7), name: 'wrong.board.eth', examStart: 1n })]);
    const checkName = vi.fn(noNames);
    const history = await loadExamHistory({ reader, registry: registryOf({ [idOf(1)]: onChain(1) }), writers: [writer, second], checkName });
    expect(history.exams).toHaveLength(1);
    expect(history.exams[0]?.writers).toEqual([writer]);
    expect(history.ignored.differs).toBe(1);
    expect(checkName).not.toHaveBeenCalled();
  });

  it('shows an exam whose reads fail as not read yet, apart from ignored rows, and checks the others', async () => {
    const reader = readerOf([examRow(1), examRow(2), examRow(3), examRow(4)]);
    const registry = registryOf({ [idOf(1)]: onChain(1), [idOf(2)]: onChain(2), [idOf(3)]: onChain(3, { list: true }) });
    const getBuild = registry.getBuild.bind(registry);
    registry.getBuild = vi.fn((examId: Hex) =>
      examId === idOf(3) ? Promise.reject(new Error('HTTP request failed. Status: 429')) : getBuild(examId),
    );
    const getExam = registry.getExam.getMockImplementation() as HistoryRegistry['getExam'];
    registry.getExam.mockImplementation((examId: Hex) => (examId === idOf(1) ? Promise.reject(new Error('rate limited')) : getExam(examId)));
    const history = await loadExamHistory({ reader, registry, writers: [writer], checkName: noNames });
    expect(history.exams.map((exam) => exam.examId)).toEqual([idOf(2)]);
    expect(history.unread).toEqual([
      { examId: idOf(1), reason: 'rate limited' },
      { examId: idOf(3), reason: 'HTTP request failed. Status: 429' },
    ]);
    expect(history.ignored).toEqual({ notOnChain: 1, differs: 0, malformed: 0, names: 0 });
  });

  it('reads nothing without writers', async () => {
    const reader = readerOf([examRow(1)]);
    const registry = registryOf({ [idOf(1)]: onChain(1) });
    const history = await loadExamHistory({ reader, registry, writers: [], checkName: noNames });
    expect(history.exams).toEqual([]);
    expect(reader.examRows).not.toHaveBeenCalled();
    expect(registry.getExam).not.toHaveBeenCalled();
  });
});

describe('finding exams by participant', () => {
  const entries = approvedList();
  const centre = entries.find((entry) => entry.role === 3);
  if (!centre) throw new Error('no centre in the fixture list');
  const hashOf = (entry: ApprovedListEntry) => sha256(entry.passkeyPublicKey).toLowerCase();

  function participantRow(n: number, over: Partial<ParticipantRow> = {}): ParticipantRow {
    return {
      entityKey: idOf(2000 + n),
      creator: writer,
      createdAtBlock: 1n,
      examId: idOf(n),
      registry: registryAddress,
      role: 'centre-holder',
      owner: centre?.owner ?? '',
      passkeyKeyHash: centre ? hashOf(centre) : '',
      derivedKeyHash: '',
      ...over,
    };
  }

  it("lists only entries on the exam's list on the registry, with matching passkey, owner and role", async () => {
    const owner = centre.owner;
    const rows = [
      participantRow(1),
      participantRow(2, { role: 'centre' }),
      participantRow(3, { passkeyKeyHash: `0x${'ee'.repeat(32)}` }),
      participantRow(4),
      participantRow(5),
    ];
    const registry = registryOf({
      [idOf(1)]: onChain(1, { list: true, entries }),
      [idOf(2)]: onChain(2, { list: true, entries }),
      [idOf(3)]: onChain(3, { list: true, entries }),
      // Exam 4 has no list on the registry, and exam 5 lists the same security key under another name.
      [idOf(4)]: onChain(4),
      [idOf(5)]: onChain(5, { list: true, entries: entries.map((entry) => (entry === centre ? { ...entry, owner: 'Someone else' } : entry)) }),
    });
    const reader = readerOf([], rows);
    const search = await findParticipant({ reader, registry, writers: [writer], owner });
    expect(reader.participantRows).toHaveBeenCalledWith({ registry: registryAddress, owner }, [writer]);
    expect(search.exams).toEqual([{ examId: idOf(1), role: 'centre-holder', examStart: 1_900_000_001n }]);
    expect(search.ignored).toEqual({ notOnList: 4, badList: 0, malformed: 0 });
    expect(search.unchecked).toEqual([]);
  });

  it('ignores and counts entries of a list whose bytes differ from the record', async () => {
    const registry = registryOf(
      { [idOf(1)]: onChain(1, { list: true, entries }) },
      { getApprovedListEntries: () => Promise.reject(new OnChainBytesError('approvedList', 'mismatch', 'differs')) },
    );
    const search = await findParticipant({ reader: readerOf([], [participantRow(1)]), registry, writers: [writer], owner: centre.owner });
    expect(search.exams).toEqual([]);
    expect(search.unchecked).toEqual([]);
    expect(search.ignored.badList).toBe(1);
  });

  it('shows an exam whose list could not be read as not checked, and checks the others', async () => {
    const registry = registryOf(
      { [idOf(1)]: onChain(1, { list: true, entries }), [idOf(2)]: onChain(2, { list: true, entries }), [idOf(3)]: onChain(3, { list: true, entries }) },
    );
    const real = registry.getApprovedListEntries.bind(registry);
    registry.getApprovedListEntries = vi.fn((examId: Hex) => {
      if (examId === idOf(2)) return Promise.reject(new Error('HTTP request failed. Status: 429'));
      if (examId === idOf(3)) return Promise.reject(new OnChainBytesError('approvedList', 'missing', 'no event returned'));
      return real(examId);
    });
    const reader = readerOf([], [participantRow(1), participantRow(2), participantRow(3)]);
    const search = await findParticipant({ reader, registry, writers: [writer], owner: centre.owner });
    expect(search.exams.map((exam) => exam.examId)).toEqual([idOf(1)]);
    expect(search.unchecked).toEqual([
      { examId: idOf(2), reason: 'HTTP request failed. Status: 429' },
      { examId: idOf(3), reason: 'no event returned' },
    ]);
    expect(search.ignored).toEqual({ notOnList: 0, badList: 0, malformed: 0 });
  });

  it('still lists a checked entry when only its start time could not be read', async () => {
    const registry = registryOf({ [idOf(1)]: onChain(1, { list: true, entries }) });
    registry.getExam.mockImplementation(() => Promise.reject(new Error('HTTP request failed. Status: 429')));
    const search = await findParticipant({ reader: readerOf([], [participantRow(1)]), registry, writers: [writer], owner: centre.owner });
    expect(search.exams).toEqual([{ examId: idOf(1), role: 'centre-holder', examStart: null }]);
  });

  it('matches the owner exactly, and reads nothing without writers', async () => {
    const reader = readerOf([], [participantRow(1)]);
    const registry = registryOf({ [idOf(1)]: onChain(1, { list: true, entries }) });
    const nearly = await findParticipant({ reader, registry, writers: [writer], owner: centre.owner.toUpperCase() });
    expect(nearly.exams).toEqual([]);
    expect(nearly.ignored.malformed).toBe(1);

    const none = readerOf([], [participantRow(1)]);
    await findParticipant({ reader: none, registry, writers: [], owner: centre.owner });
    expect(none.participantRows).not.toHaveBeenCalled();
  });

  it('says each role in plain words', () => {
    expect(roleWords('setter')).toBe('Setter');
    expect(roleWords('neutral')).toBe('Key holder');
    expect(roleWords('centre-holder')).toBe('Centre holding part of the key');
    expect(roleWords('centre')).toBe('Centre that gets the key when the paper unlocks');
    expect(roleWords('admin')).toBe('Unknown role');
  });
});

describe('examStatus', () => {
  const rounds = { lock: 100n, unlock: 200n, end: 300n };
  const start = BigInt(roundTimeSeconds(250));
  const at = (round: number) => roundTimeSeconds(round);

  it('reads an exam with no paper past its start as never ran', () => {
    expect(examStatus({ examStart: start, stage: 'listed', rounds }, 260, at(260))).toBe('never-ran');
    expect(examStatus({ examStart: start, stage: 'published', rounds }, 260, at(260))).toBe('never-ran');
  });

  it('follows an exam from setting up to finished', () => {
    expect(examStatus({ examStart: start, stage: 'published', rounds }, 50, at(50))).toBe('setup');
    expect(examStatus({ examStart: start, stage: 'listed', rounds }, 50, at(50))).toBe('questions');
    expect(examStatus({ examStart: start, stage: 'listed', rounds }, 150, at(150))).toBe('waiting');
    expect(examStatus({ examStart: start, stage: 'built', rounds }, 150, at(150))).toBe('sealed');
    expect(examStatus({ examStart: start, stage: 'built', rounds }, 250, at(250))).toBe('under-way');
    expect(examStatus({ examStart: start, stage: 'built', rounds }, 300, at(300))).toBe('finished');
  });
});
