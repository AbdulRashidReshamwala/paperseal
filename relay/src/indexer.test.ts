import type { ExamRow } from '@paperseal/arkiv';
import type { ExamNameResult, ScanEventsResult, ScannedExam } from '@paperseal/chain';
import { encodeApprovedList, setterOwner, toHex, type ApprovedListEntry } from '@paperseal/protocol';
import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { defaultSepoliaRpc, parseCommand, UsageError, type IndexTarget } from './args';
import {
  checkNames,
  indexLoop,
  indexPass,
  indexReportLines,
  newIndexState,
  rpcLabel,
  type IndexDeps,
  type IndexRegistry,
  type IndexWriter,
} from './indexer';
import { examStartText, indexStatus, indexStatusLines } from './status';

const REGISTRY: Address = '0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8';
const OTHER_REGISTRY: Address = '0x1111111111111111111111111111111111111111';
const BOARD: Address = '0x2222222222222222222222222222222222222222';
const EXAM: Hex = `0x${'ab'.repeat(32)}`;
const EXAM2: Hex = `0x${'cd'.repeat(32)}`;
const CRITERIA: Hex = `0x${'c1'.repeat(32)}`;
const LIST_HASH: Hex = `0x${'1a'.repeat(32)}`;
const PAPER: Hex = `0x${'9a'.repeat(32)}`;
const TX: Hex = `0x${'77'.repeat(32)}`;
const links = { entity: (k: Hex) => `https://x/entity/${k}`, tx: (h: Hex) => `https://x/tx/${h}` };

const point = (byte: number) => {
  const key = new Uint8Array(65).fill(byte);
  key[0] = 4;
  return key;
};

/** 1 setter, 3 neutrals, 7 centre key holders: a list that passes the rules. */
function validList(): { entries: ApprovedListEntry[]; bytes: Hex } {
  const setterKey = point(1);
  const entries: ApprovedListEntry[] = [
    { role: 1, passkeyPublicKey: setterKey, derivedPublicKey: new Uint8Array(), owner: setterOwner(setterKey) },
    ...[2, 3, 4].map((i) => ({ role: 2, passkeyPublicKey: point(i * 2), derivedPublicKey: point(i * 2 + 1), owner: `neutral-${String(i)}` })),
    ...[10, 11, 12, 13, 14, 15, 16].map((i) => ({ role: 3, passkeyPublicKey: point(i * 2), derivedPublicKey: point(i * 2 + 1), owner: `centre-${String(i)}` })),
  ];
  return { entries, bytes: toHex(encodeApprovedList(entries)) };
}

const created = (examId: Hex, block = 120n) => ({
  block,
  txHash: TX,
  commitHash: `0x${'00'.repeat(20)}` as Hex,
  imageDigest: `0x${'00'.repeat(32)}` as Hex,
  examStart: 1_790_000_000n,
  delta: 60n,
  lockRound: 1n,
  unlockRound: 2n,
  endRound: 3n,
  criteriaHash: CRITERIA,
  rpcHost: 'rpc.example',
  criteria: '0x' as Hex,
  examId,
});
const list = (entries: Hex, block = 130n) => ({ block, txHash: TX, listHash: LIST_HASH, entries });
const build = (block = 140n) => ({
  block,
  txHash: TX,
  approvedListHash: LIST_HASH,
  paperHash: PAPER,
  storageManifestHash: PAPER,
  saltedPaperHash: PAPER,
  selected: 1,
  bankSize: 2,
  criteriaHash: CRITERIA,
  teeSignature: '0x' as Hex,
  instancePublicKey: '0x' as Hex,
});

function scannedExam(examId: Hex, parts: Partial<Omit<ScannedExam, 'examId'>>): ScannedExam {
  const { created: c = null, ...rest } = parts;
  return { examId, created: c ? { ...c } : null, ...rest } as ScannedExam;
}

function mocks(scans: ScanEventsResult[], overrides: { getExam?: () => Promise<unknown> } = {}) {
  const queue = [...scans];
  const registry = {
    board: vi.fn(() => Promise.resolve(BOARD)),
    scanEvents: vi.fn(({ fromBlock }: { fromBlock: bigint }) => {
      const next = queue.shift();
      if (!next) return Promise.resolve({ fromBlock, toBlock: fromBlock - 1n, exams: [] });
      return Promise.resolve(next);
    }),
    getExam: vi.fn(
      overrides.getExam ??
        (() =>
          Promise.resolve({
            commitHash: '0x',
            imageDigest: '0x',
            createdAt: 1n,
            createdBlock: 50n,
            settings: { examId: EXAM, examStart: 1_780_000_000n, criteriaHash: CRITERIA },
          })),
    ),
    getApprovedList: vi.fn(() => Promise.resolve({ listHash: LIST_HASH, postedAt: 1n, postedBlock: 60n })),
    getApprovedListEntries: vi.fn(() => Promise.resolve(validList().bytes)),
  };
  let n = 0;
  const writer = {
    address: '0x3333333333333333333333333333333333333333' as Address,
    upsertExam: vi.fn(() => Promise.resolve({ action: 'created' as const, entityKey: `0x${'e1'.repeat(32)}` as Hex, txHash: TX })),
    mirrorParticipants: vi.fn(({ entries }: { entries: readonly unknown[] }) =>
      Promise.resolve({
        written: entries.map(() => ({ passkeyKeyHash: `0x${(n++).toString(16).padStart(64, '0')}`, entityKey: `0x${'e2'.repeat(32)}` as Hex })),
        skipped: [],
        txHashes: [TX],
      }),
    ),
  };
  const resolveName = vi.fn((_: string): Promise<ExamNameResult> => Promise.reject(new Error('no names expected')));
  const deps: IndexDeps = {
    registry: registry as unknown as IndexRegistry,
    writer: writer as unknown as IndexWriter,
    resolveName,
    chainId: 11155111,
  };
  return { registry, writer, resolveName, deps };
}

const target = (extra: Partial<IndexTarget> = {}): IndexTarget => ({
  registry: REGISTRY,
  fromBlock: 100n,
  toBlock: undefined,
  rpcUrl: defaultSepoliaRpc,
  rpcSource: 'default',
  names: [],
  everySeconds: undefined,
  ...extra,
});

const okName = (name: string, examId: Hex, registry: Address): ExamNameResult => ({
  ok: true,
  value: {
    name,
    label: name.split('.')[0] ?? '',
    parent: name.split('.').slice(1).join('.'),
    examId,
    registry,
    board: BOARD,
    teeUrl: null,
    storageUrl: null,
    bucket: null,
    arkivWriters: null,
    arkivWritersIgnored: [],
  },
});

describe('index input building', () => {
  it('writes a published exam from ExamCreated, with no list hashes and no participants', async () => {
    const { deps, writer, registry } = mocks([{ fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { created: created(EXAM) })] }]);
    const report = await indexPass(target(), deps, newIndexState(100n));
    expect(writer.upsertExam).toHaveBeenCalledWith({
      examId: EXAM,
      registry: REGISTRY,
      board: BOARD,
      chainId: 11155111,
      stage: 'published',
      examStart: 1_790_000_000n,
      createdBlock: 120n,
      criteriaHash: CRITERIA,
      approvedListHash: null,
      paperHash: null,
      name: null,
    });
    expect(registry.getExam).not.toHaveBeenCalled();
    expect(writer.mirrorParticipants).not.toHaveBeenCalled();
    expect(report.outcomes[0]).toMatchObject({ action: 'created', participants: { result: 'none' } });
    expect(registry.scanEvents).toHaveBeenCalledWith({ fromBlock: 100n, chunk: 10_000 });
  });

  it('writes a listed exam, and passes the decoded entries to mirrorParticipants', async () => {
    const { entries, bytes } = validList();
    const { deps, writer, registry } = mocks([{ fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { created: created(EXAM), list: list(bytes) })] }]);
    const report = await indexPass(target(), deps, newIndexState(100n));
    expect(writer.upsertExam).toHaveBeenCalledWith(expect.objectContaining({ stage: 'listed', approvedListHash: LIST_HASH, paperHash: null }));
    expect(registry.getApprovedListEntries).not.toHaveBeenCalled();
    expect(writer.mirrorParticipants).toHaveBeenCalledWith({ examId: EXAM, registry: REGISTRY, entries });
    expect(report.outcomes[0]?.participants).toMatchObject({ result: 'mirrored', written: 11, skipped: 0 });
    // Upsert first, then participants.
    expect(writer.upsertExam.mock.invocationCallOrder[0]).toBeLessThan(writer.mirrorParticipants.mock.invocationCallOrder[0] ?? 0);
  });

  it('fills a built exam whose ExamCreated and list came before the range from getExam and getApprovedList', async () => {
    const { entries } = validList();
    const { deps, writer, registry } = mocks([{ fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { build: build() })] }]);
    await indexPass(target(), deps, newIndexState(100n));
    expect(registry.getExam).toHaveBeenCalledWith(EXAM);
    expect(registry.getApprovedList).toHaveBeenCalledWith(EXAM);
    expect(writer.upsertExam).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'built', examStart: 1_780_000_000n, createdBlock: 50n, criteriaHash: CRITERIA, approvedListHash: LIST_HASH, paperHash: PAPER }),
    );
    expect(registry.getApprovedListEntries).toHaveBeenCalledWith(EXAM);
    expect(writer.mirrorParticipants).toHaveBeenCalledWith({ examId: EXAM, registry: REGISTRY, entries });
  });

  it('fails an exam getExam does not have, and writes nothing for it', async () => {
    const { deps, writer } = mocks([{ fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { list: list(validList().bytes) })] }], {
      getExam: vi.fn(() => Promise.resolve(null)),
    });
    const report = await indexPass(target(), deps, newIndexState(100n));
    expect(report.outcomes[0]).toMatchObject({ action: 'failed' });
    expect(report.outcomes[0]?.detail).toContain('getExam has no such exam');
    expect(writer.upsertExam).not.toHaveBeenCalled();
    expect(writer.mirrorParticipants).not.toHaveBeenCalled();
  });
});

describe('index names', () => {
  it('sets a name only when it passes, and its registry and exam ID match', async () => {
    const { deps, writer, resolveName } = mocks([
      { fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { created: created(EXAM) }), scannedExam(EXAM2, { created: created(EXAM2) })] },
    ]);
    resolveName.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'good.board.eth'
          ? okName(name, EXAM, REGISTRY.toLowerCase() as Address)
          : name === 'elsewhere.board.eth'
            ? okName(name, EXAM2, OTHER_REGISTRY)
            : { ok: false, failed: 'primaryName', reason: 'The board calls itself other.eth.', partial: { name } },
      ),
    );
    const report = await indexPass(target({ names: ['good.board.eth', 'elsewhere.board.eth', 'bad.board.eth'] }), deps, newIndexState(100n));
    const calls = writer.upsertExam.mock.calls as unknown as [{ examId: Hex; name: string | null }][];
    expect(calls.map(([input]) => [input.examId, input.name])).toEqual([
      [EXAM, 'good.board.eth'],
      [EXAM2, null],
    ]);
    expect(report.names).toEqual([
      `checked good.board.eth: exam ${EXAM}`,
      `skipped elsewhere.board.eth: it points to registry ${OTHER_REGISTRY}, not ${REGISTRY}`,
      'skipped bad.board.eth: failed the primaryName check: The board calls itself other.eth.',
    ]);
  });

  it('notes a verified name whose exam has no event in range, and sets it on no other exam', async () => {
    const { deps, writer, resolveName } = mocks([{ fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { created: created(EXAM) })] }]);
    resolveName.mockResolvedValue(okName('other.board.eth', EXAM2, REGISTRY));
    const report = await indexPass(target({ names: ['other.board.eth'] }), deps, newIndexState(100n));
    expect(writer.upsertExam).toHaveBeenCalledWith(expect.objectContaining({ examId: EXAM, name: null }));
    expect(report.notes).toEqual([`other.board.eth names exam ${EXAM2}, which has no event in the blocks scanned so far`]);
  });

  it('treats a resolver that throws as a skipped name', async () => {
    const check = await checkNames(['x.board.eth'], REGISTRY, () => Promise.reject(new Error('socket hang up')));
    expect(check.byExam.size).toBe(0);
    expect(check.lines[0]).toContain('skipped x.board.eth: failed the unreadable check');
  });

  it('holds a new exam whose name the RPC could not read, rather than writing it without the name', async () => {
    const { deps, writer, resolveName } = mocks([{ fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { created: created(EXAM) })] }]);
    resolveName.mockResolvedValue({ ok: false, failed: 'unreadable', reason: 'RPC down', partial: { examId: EXAM } });
    const report = await indexPass(target({ names: ['good.board.eth'] }), deps, newIndexState(100n));
    expect(writer.upsertExam).not.toHaveBeenCalled();
    expect(report.outcomes[0]).toMatchObject({ examId: EXAM, action: 'held' });
  });
});

describe('index participants', () => {
  it('writes no participants for a list that fails the list rules, and does not try it again', async () => {
    const { entries } = validList();
    const bad = toHex(encodeApprovedList(entries.slice(0, 5))); // too few key holders
    const { deps, writer } = mocks([
      { fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { created: created(EXAM), list: list(bad) })] },
      { fromBlock: 201n, toBlock: 300n, exams: [scannedExam(EXAM, { build: build(250n) })] },
    ]);
    const state = newIndexState(100n);
    const first = await indexPass(target(), deps, state);
    expect(writer.upsertExam).toHaveBeenCalledTimes(1);
    expect(writer.mirrorParticipants).not.toHaveBeenCalled();
    expect(first.outcomes[0]?.participants.result).toBe('refused');
    expect(first.outcomes[0]?.participants.detail).toContain('fails the list rules');
    const second = await indexPass(target(), deps, state);
    expect(writer.mirrorParticipants).not.toHaveBeenCalled();
    expect(second.outcomes[0]).toMatchObject({ participants: { result: 'refused' } });
  });

  it('writes no participants for bytes that are not an approved list at all', async () => {
    const { deps, writer } = mocks([{ fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { created: created(EXAM), list: list('0x1234') })] }]);
    const report = await indexPass(target(), deps, newIndexState(100n));
    expect(writer.mirrorParticipants).not.toHaveBeenCalled();
    expect(report.outcomes[0]?.participants.result).toBe('refused');
    expect(indexReportLines(report, links).join('\n')).toContain('participants none written');
  });
});

describe('index loop', () => {
  it('resumes from the last toBlock + 1, builds on what it saw, and never moves the stage back', async () => {
    const { bytes } = validList();
    const { deps, writer, registry } = mocks([
      { fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { created: created(EXAM), list: list(bytes) })] },
      { fromBlock: 201n, toBlock: 300n, exams: [scannedExam(EXAM, { build: build(250n) })] },
    ]);
    const controller = new AbortController();
    const reports: unknown[] = [];
    let sleeps = 0;
    const state = await indexLoop(target({ everySeconds: 5 }), {
      ...deps,
      signal: controller.signal,
      sleep: () => {
        sleeps += 1;
        if (sleeps === 3) controller.abort();
        return Promise.resolve();
      },
      onReport: (r) => reports.push(r),
      onError: (m) => {
        throw new Error(m);
      },
    });
    const froms = (registry.scanEvents.mock.calls as unknown as [{ fromBlock: bigint }][]).map(([o]) => o.fromBlock);
    expect(froms).toEqual([100n, 201n, 301n]);
    expect(state.nextBlock).toBe(301n);
    const stages = (writer.upsertExam.mock.calls as unknown as [{ stage: string; approvedListHash: Hex | null; createdBlock: bigint }][]).map(([i]) => [i.stage, i.approvedListHash, i.createdBlock]);
    expect(stages).toEqual([
      ['listed', LIST_HASH, 120n],
      ['built', LIST_HASH, 120n],
    ]);
    // ExamCreated and the list came from the first scan, so nothing is read from the registry.
    expect(registry.getExam).not.toHaveBeenCalled();
    expect(registry.getApprovedList).not.toHaveBeenCalled();
    // The list was mirrored once, in the first pass.
    expect(writer.mirrorParticipants).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(3);
    expect(registry.board).toHaveBeenCalledTimes(1);
  });

  it('tries a failed write again on the next pass with no new event, and a failed scan from the same block', async () => {
    const { deps, writer, registry } = mocks([{ fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { created: created(EXAM) })] }]);
    writer.upsertExam.mockRejectedValueOnce(new Error('nonce too low'));
    registry.scanEvents.mockImplementationOnce(() => Promise.reject(new Error('rate limited')));
    const errors: string[] = [];
    const controller = new AbortController();
    let sleeps = 0;
    const reports: { outcomes: { action: string }[] }[] = [];
    await indexLoop(target({ everySeconds: 5 }), {
      ...deps,
      signal: controller.signal,
      sleep: () => {
        sleeps += 1;
        if (sleeps === 3) controller.abort();
        return Promise.resolve();
      },
      onReport: (r) => reports.push(r),
      onError: (m) => errors.push(m),
    });
    expect(errors[0]).toContain('trying blocks from 100 again');
    const froms = (registry.scanEvents.mock.calls as unknown as [{ fromBlock: bigint }][]).map(([o]) => o.fromBlock);
    expect(froms).toEqual([100n, 100n, 201n]);
    expect(reports.map((r) => r.outcomes.map((o) => o.action))).toEqual([['failed'], ['created']]);
  });

  it('stops after one pass without --every', async () => {
    const { deps, registry } = mocks([]);
    await indexLoop(target(), { ...deps, signal: new AbortController().signal, sleep: () => Promise.reject(new Error('slept')), onReport: () => undefined, onError: () => undefined });
    expect(registry.scanEvents).toHaveBeenCalledTimes(1);
  });
});

describe('index arguments', () => {
  it('parses index, with the RPC from --rpc, then RELAY_SEPOLIA_RPC, then the default', () => {
    const base = ['index', '--registry', REGISTRY.toLowerCase(), '--from-block', '100'];
    expect(parseCommand(base, {})).toEqual({
      command: 'index',
      target: { registry: REGISTRY, fromBlock: 100n, toBlock: undefined, rpcUrl: defaultSepoliaRpc, rpcSource: 'default', names: [], everySeconds: undefined },
    });
    expect(parseCommand(base, { RELAY_SEPOLIA_RPC: 'https://env.example/key' })).toMatchObject({ target: { rpcUrl: 'https://env.example/key', rpcSource: 'RELAY_SEPOLIA_RPC' } });
    expect(parseCommand([...base, '--rpc', 'https://flag.example'], { RELAY_SEPOLIA_RPC: 'https://env.example' })).toMatchObject({
      target: { rpcUrl: 'https://flag.example', rpcSource: '--rpc' },
    });
    expect(parseCommand([...base, '--to-block', '200', '--names', ' a.b.eth, c.b.eth,a.b.eth,'], {})).toMatchObject({
      target: { toBlock: 200n, names: ['a.b.eth', 'c.b.eth'] },
    });
    expect(parseCommand([...base, '--every', '30'], {})).toMatchObject({ target: { everySeconds: 30 } });
  });

  it.each([
    [['index', '--from-block', '1']],
    [['index', '--registry', REGISTRY]],
    [['index', '--registry', REGISTRY, '--from-block', '-1']],
    [['index', '--registry', REGISTRY, '--from-block', '0x10']],
    [['index', '--registry', REGISTRY, '--from-block', '10', '--to-block', '9']],
    [['index', '--registry', REGISTRY, '--from-block', '10', '--to-block', '20', '--every', '5']],
    [['index', '--registry', REGISTRY, '--from-block', '10', '--rpc', 'ws://x']],
    [['index', '--registry', REGISTRY, '--from-block', '10', '--names', ' , ']],
    [['index', '--registry', REGISTRY, '--from-block', '10', '--exam', EXAM]],
    [['status', '--index']],
    [['status', '--index', '--registry', REGISTRY, '--exam', EXAM]],
  ])('refuses %j', (argv) => {
    expect(() => parseCommand(argv, {})).toThrow(UsageError);
  });

  it('parses status --index, which needs --registry and no --exam', () => {
    expect(parseCommand(['status', '--index', '--registry', REGISTRY.toLowerCase()])).toEqual({ command: 'status-index', registry: REGISTRY, writer: undefined });
  });

  it('hides an RPC URL path, where providers put keys', () => {
    expect(rpcLabel(defaultSepoliaRpc)).toEqual({ shown: defaultSepoliaRpc, secrets: [] });
    expect(rpcLabel('https://eth-sepolia.g.alchemy.com/v2/KEY')).toEqual({
      shown: 'https://eth-sepolia.g.alchemy.com/[redacted]',
      secrets: ['https://eth-sepolia.g.alchemy.com/v2/KEY', '/v2/KEY'],
    });
  });
});

describe('index report', () => {
  it('prints each exam with its action, entity link and participants, then a summary', async () => {
    const { bytes } = validList();
    const { deps } = mocks([{ fromBlock: 100n, toBlock: 200n, exams: [scannedExam(EXAM, { created: created(EXAM), list: list(bytes) })] }]);
    const lines = indexReportLines(await indexPass(target(), deps, newIndexState(100n)), links);
    expect(lines[0]).toBe(`  exam   ${EXAM}  created  (listed, no name)`);
    expect(lines[1]).toBe(`         entity 0x${'e1'.repeat(32)}  https://x/entity/0x${'e1'.repeat(32)}`);
    expect(lines).toContain('         participants written 11, skipped 0 (already on Arkiv)');
    expect(lines.at(-1)).toMatch(/blocks 100-200: 1 exam, created 1, patched 0, unchanged 0, held 0, failed 0; participants written 11, skipped 0; lists refused 0, failed 0$/);
  });
});

describe('status --index', () => {
  const row = (examId: string, examStart: bigint, name: string, stage: string): ExamRow => ({
    entityKey: `0x${examId.slice(2, 4).repeat(32)}`,
    creator: BOARD,
    createdAtBlock: 1n,
    examId,
    registry: REGISTRY,
    board: BOARD,
    chainId: 11155111n,
    stage,
    examStart,
    createdBlock: 1n,
    criteriaHash: CRITERIA,
    approvedListHash: '',
    paperHash: '',
    name,
  });

  it('lists the rows for the registry from the writer, by examStart', async () => {
    const examRows = vi.fn(() => Promise.resolve([row(EXAM2, 1_790_000_000n, '', 'published'), row(EXAM, 1_780_000_000n, 'jee.board.eth', 'built')]));
    const rows = await indexStatus({ examRows }, REGISTRY, BOARD);
    expect(examRows).toHaveBeenCalledWith(REGISTRY, [BOARD]);
    expect(indexStatusLines(rows, links.entity)).toEqual([
      '2 exam rows from this writer, by examStart',
      `  built     2026-05-28T20:26:40.000Z  jee.board.eth  exam ${EXAM}`,
      `            entity 0x${'ab'.repeat(32)}  https://x/entity/0x${'ab'.repeat(32)}`,
      `  published 2026-09-21T14:13:20.000Z  (no name)  exam ${EXAM2}`,
      `            entity 0x${'cd'.repeat(32)}  https://x/entity/0x${'cd'.repeat(32)}`,
    ]);
  });

  it('says when there are no rows, and shows a date Date cannot hold as a number', () => {
    expect(indexStatusLines([], links.entity)).toEqual(['0 exam rows from this writer, by examStart']);
    expect(examStartText(2n ** 63n)).toBe(`T=${(2n ** 63n).toString()}`);
  });
});
