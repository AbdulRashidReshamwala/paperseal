import type { EnsLookup } from '@paperseal/chain';
import { roundTimeSeconds, type Hex } from '@paperseal/protocol';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createBackupCache, createStorage, type ChainData } from '@paperseal/verify';
import { buildWorld, examId, registryAddress, registryMatches, storageBucket, type World } from '@paperseal/verify/fixtures';
import { custody, type View } from './custody';
import { copies, duration, people, timeline, type Copy, type PieceId } from './facts';
import { findVersion, readBoardName, readExamName } from './identity';
import { loadRecords, type ArkivReport, type Records } from './load';
import type { Polled } from './poll';
import { loadSwarm, type BackupRow, type SwarmReport } from './swarm';

let world: World;
let chain: ChainData;
let records: Records;

const writer: Hex = '0x1111111111111111111111111111111111111111';
const reference = 'ab'.repeat(32);
const row = { entityKey: `0x${'cd'.repeat(32)}`, creator: writer, createdAtBlock: 90n, examId, registry: registryAddress, phase: 'unlock', swarmRef: reference, swarmNetwork: 'sepolia', files: 25, batchId: 'ee' } as unknown as BackupRow;

const storageOf = (files: ReadonlyMap<string, Uint8Array>) =>
  createStorage('https://files.example/bucket', examId, (input) => {
    const name = String(input).replace(`https://files.example/bucket/${examId}/`, '');
    const bytes = files.get(name);
    return Promise.resolve(
      bytes ? new Response(new Uint8Array(bytes), { headers: { 'last-modified': 'Fri, 06 Nov 2026 18:05:46 GMT' } }) : new Response('no', { status: 404 }),
    );
  });

beforeAll(async () => {
  world = await buildWorld();
  chain = {
    registryCode: registryMatches,
    exam: world.exam,
    list: { listHash: world.build.approvedListHash, postedAt: 1_000_000n },
    build: world.build,
    criteria: world.criteriaHex,
    entries: world.entriesHex,
  } as ChainData;
  records = await loadRecords({ chain: () => Promise.resolve(chain), storage: storageOf(world.files), examId, registry: registryAddress, bucket: storageBucket, trustedRoot: world.pki.root });
});

const viewOf = (over: Partial<View> = {}): View => ({
  examId,
  invalidLink: false,
  sources: { chain: true, storage: true, tee: false, arkiv: true },
  records: { state: 'ready', value: records, readAt: 0 },
  live: { state: 'off' },
  arkiv: { state: 'off' },
  latest: { round: 100_000_000, error: null },
  now: 2_000_000_000,
  proof: null,
  ...over,
});

/** A collection on a stub Swarm node, with these files. */
const swarmWith = (files: ReadonlyMap<string, Uint8Array> | Error) => ({
  download: vi.fn((_: string, path: string) => (files instanceof Error ? Promise.reject(files) : Promise.resolve(files.get(path) ?? null))),
});

async function audit(files: ReadonlyMap<string, Uint8Array> | Error | null, rows: BackupRow[] = [row]) {
  return loadSwarm({
    rows: { backupRows: () => Promise.resolve(rows), latestBlock: () => Promise.resolve({ number: 100n, time: 1_900_000_000 }) },
    swarm: files === null ? null : swarmWith(files),
    apiUrl: 'https://bee.example/',
    cache: createBackupCache(),
    chain: () => chain,
    writers: [writer],
    examId,
    registry: registryAddress,
    bucket: storageBucket,
    trustedRoot: world.pki.root,
  });
}

const ready = (value: SwarmReport): Polled<SwarmReport> => ({ state: 'ready', value, readAt: 0 });
const none = { progressSource: 'storage' } as const;

function copyIn(found: ReturnType<typeof copies>, id: PieceId, source: Copy['source']): Copy {
  const copy = found?.pieces.find((piece) => piece.id === id)?.copies.find((one) => one.source === source);
  if (!copy) throw new Error(`no ${source} copy of ${id}`);
  return copy;
}

describe('the Swarm copy', () => {
  it('says plainly when no backup is recorded, and claims nothing', async () => {
    const found = copies(viewOf(), none, ready(await audit(new Map(), [])));
    for (const id of ['log', 'token', 'paper', 'keys'] as const) {
      expect(copyIn(found, id, 'swarm')).toEqual({ source: 'swarm', state: 'missing', note: 'No backup is recorded for this exam.' });
    }
  });

  it('is checked only once a real collection passes the same checks as the bucket', async () => {
    const report = await audit(world.files);
    const found = copies(viewOf(), none, ready(report));
    for (const id of ['log', 'token', 'paper', 'keys'] as const) expect(copyIn(found, id, 'swarm').state).toBe('checked');
    const log = copyIn(found, 'log', 'swarm');
    expect(log.reference).toEqual({ label: 'Swarm reference', value: reference });
    expect(log.links?.[0]?.href).toBe(`https://bee.example/bzz/${reference}/manifest.json`);
    expect(log.at).toBe(1_900_000_000 - 10 * 2);
    expect(log.used).toBeUndefined();
    expect(copyIn(found, 'log', 'bucket').used).toBe(true);
  });

  it('never calls a changed file checked', async () => {
    const changed = new Map(world.files);
    changed.set('release-log.json', new TextEncoder().encode('{"not":"a log"}'));
    changed.set('manifest.json', new TextEncoder().encode('{}'));
    const found = copies(viewOf(), none, ready(await audit(changed)));
    expect(copyIn(found, 'log', 'swarm').state).toBe('failed');
    expect(copyIn(found, 'paper', 'swarm').state).toBe('failed');
  });

  it('holds but does not check a backup with no Swarm API to read it through', async () => {
    const found = copies(viewOf(), none, ready(await audit(null)));
    const copy = copyIn(found, 'log', 'swarm');
    expect(copy.state).toBe('held');
    expect(copy.reference?.value).toBe(reference);
  });

  it('shows a node that does not answer as its own state, never a pass or a failure', async () => {
    const found = copies(viewOf(), none, ready(await audit(new Error('node down'))));
    expect(copyIn(found, 'log', 'swarm').state).toBe('unread');
    expect(copyIn(found, 'paper', 'swarm').state).toBe('unread');
  });

  it('shows a failed lookup on Arkiv as its own state', () => {
    const found = copies(viewOf(), none, { state: 'error', message: 'Rabdi said 429' });
    const copy = copyIn(found, 'keys', 'swarm');
    expect(copy.state).toBe('unread');
    expect(copy.note).toMatch(/does not fail the exam/);
  });

  it('marks Swarm as used when the file came from there', async () => {
    const backup = { served: [{ name: 'release-log.json' }], missed: [], ignored: { collections: 0, files: 0 }, rejected: [] } as unknown as Records['backup'];
    const view = viewOf({ records: { state: 'ready', value: { ...records, ...(backup ? { backup } : {}) }, readAt: 0 } });
    const found = copies(view, none, ready(await audit(world.files)));
    expect(copyIn(found, 'log', 'swarm').used).toBe(true);
    expect(copyIn(found, 'log', 'bucket').used).toBeUndefined();
  });

  it('cannot change a step: the chain of custody takes nothing from it', () => {
    const noFiles = { ...records, token: { kind: 'neutral', message: 'none' }, manifest: { kind: 'neutral', message: 'none' }, log: { kind: 'neutral', message: 'none' } } as Records;
    const result = custody(viewOf({ records: { state: 'ready', value: noFiles, readAt: 0 } }));
    expect(result.steps.find((step) => step.id === 'attested')?.state).not.toBe('done');
    expect(result.steps.find((step) => step.id === 'sealed')?.state).not.toBe('done');
  });
});

describe('the other copies', () => {
  const report = (over: Partial<ArkivReport>): ArkivReport => ({
    writers: [writer],
    read: { logs: 0, tokens: 0, heartbeats: 0 },
    log: null,
    token: null,
    ignored: { tokens: 0, unreadable: 0, unattested: 0, failed: 0 },
    heartbeat: null,
    newestAt: null,
    ageSeconds: null,
    ...over,
  });

  it('holds Arkiv rows that have not passed, with no link to vouch for them', () => {
    const copy = copyIn(copies(viewOf({ arkiv: { state: 'ready', value: report({ read: { logs: 2, tokens: 1, heartbeats: 0 } }), readAt: 0 } }), none), 'log', 'arkiv');
    expect(copy.state).toBe('held');
    expect(copy.links).toBeUndefined();
  });

  it('says Reading while a source loads, and could not be read only after a real failure', () => {
    const reading = copies(viewOf({ arkiv: { state: 'loading' } }), none, { state: 'loading' });
    expect(copyIn(reading, 'log', 'arkiv')).toMatchObject({ state: 'reading', note: '' });
    expect(copyIn(reading, 'log', 'swarm')).toMatchObject({ state: 'reading', note: '' });
    expect(reading?.feed).toMatchObject({ state: 'reading', text: 'Reading.' });
    const failed = copies(viewOf({ arkiv: { state: 'error', message: '429' } }), none, { state: 'error', message: '429' });
    expect(copyIn(failed, 'log', 'arkiv').state).toBe('unread');
    expect(copyIn(failed, 'log', 'swarm').state).toBe('unread');
    expect(failed?.feed.state).toBe('unread');
  });

  it('says when Arkiv has no row, and when it could not be read', () => {
    expect(copyIn(copies(viewOf({ arkiv: { state: 'ready', value: report({}), readAt: 0 } }), none), 'log', 'arkiv').state).toBe('missing');
    expect(copyIn(copies(viewOf({ arkiv: { state: 'error', message: '429' } }), none), 'log', 'arkiv').state).toBe('unread');
  });

  it('does not call a record of releases absent when it could not be read', () => {
    const view = viewOf();
    if (view.records.state !== 'ready') throw new Error('no records');
    const log = { kind: 'unavailable', message: 'Storage returned 503' } as const;
    const found = copies({ ...view, records: { ...view.records, value: { ...view.records.value, log } } }, none);
    expect(copyIn(found, 'token', 'bucket').state).toBe('unread');
    expect(copyIn(found, 'keys', 'bucket').state).toBe('unread');
    expect(copyIn(found, 'keys', 'bucket').note).not.toMatch(/not here yet/);
  });

  it('gives the time the bucket says it wrote a file', () => {
    expect(copyIn(copies(viewOf(), none), 'log', 'bucket').at).toBe(Date.parse('2026-11-06T18:05:46Z') / 1000);
  });

  it('does not ask a machine about a finished exam, and does not count it', () => {
    const copy = copyIn(copies(viewOf({ sources: { chain: true, storage: true, tee: true, arkiv: false } }), none), 'log', 'tee');
    expect(copy.state).toBe('off');
    expect(copy.note).toMatch(/recorded while it ran/);
  });

  it('warns about a feed that has stopped only while release is open', () => {
    const stale = report({ ageSeconds: 600, newestAt: 1000 });
    const arkiv = { state: 'ready', value: stale, readAt: 0 } as const;
    const unlock = Number(world.exam.settings.unlockRound);
    const open = copies(viewOf({ arkiv, latest: { round: unlock, error: null }, now: roundTimeSeconds(unlock) }), none);
    expect(open?.feed.state).toBe('stopped');
    expect(open?.feed.text).toMatch(/does not mean no one has released/);
    expect(copies(viewOf({ arkiv }), none)?.feed.state).toBe('quiet');
  });
});

describe('people', () => {
  it('lists setters only as codes, and names everyone else', () => {
    const found = people(viewOf());
    expect(found?.setters.every((code) => /^0x[0-9a-f]{64}$/.test(code))).toBe(true);
    expect(found?.holders.length).toBeGreaterThan(0);
    expect(found?.holders[0]?.name).toMatch(/\.eth$/);
  });

  it('takes release times from a verified log, and from nothing else', async () => {
    const log = records.log;
    if (log.kind !== 'ready') throw new Error('no log');
    const release = log.releases?.[0];
    if (!release) throw new Error('no release');
    const found = people(viewOf());
    const everyone = [...(found?.holders ?? []), ...(found?.centres ?? [])];
    expect(everyone.filter((person) => person.released).length).toBe(log.releases?.length);

    const unverified = { ...records, log: { ...log, token: null } };
    const hearsay = people(viewOf({ records: { state: 'ready', value: unverified, readAt: 0 } }));
    expect([...(hearsay?.holders ?? []), ...(hearsay?.centres ?? [])].some((person) => person.released)).toBe(false);
    expect(hearsay?.verified).toBe(false);
  });

  it('says could not be checked for a read with no answer, and notes a name that changed since', () => {
    const base = people(viewOf())?.holders[0];
    if (!base) throw new Error('no holder');
    const answer = (value: object) => ({ state: 'ready', value: { [base.key]: value }, readAt: 0 }) as unknown as NonNullable<View['partyNames']>;
    const failed = people(viewOf({ partyNames: answer({ state: 'unreadable', name: base.name, expected: '0x', reason: '' }) }));
    expect(failed?.holders[0]?.state).toMatchObject({ tone: 'neutral', word: 'Could not be checked' });
    const changed = people(viewOf({ partyNames: answer({ state: 'confirmed', name: base.name, expected: '0x', reason: '', changedSince: true }) }));
    expect(changed?.holders[0]?.state.word).toBe('Name confirmed');
    expect(changed?.holders[0]?.state.note).toMatch(/has changed since/);
  });

  it('shows a name with no answer yet as could not be checked, and a confirmed one as confirmed', () => {
    const base = people(viewOf())?.holders[0];
    if (!base) throw new Error('no holder');
    const partyNames = { state: 'ready', value: { [base.key]: { state: 'confirmed', name: base.name, expected: '0x', reason: '' } }, readAt: 0 } as unknown as View['partyNames'];
    const named = people(viewOf(partyNames ? { partyNames } : {}));
    expect(named?.holders[0]?.state.word).toBe('Name confirmed');
    expect(named?.holders[1]?.state.word).toBe('Could not be checked');
  });
});

describe('the timeline', () => {
  it('is in time order, from the record, with the delay against the schedule', () => {
    const moments = timeline(viewOf());
    expect(moments.map((moment) => moment.at)).toEqual([...moments.map((moment) => moment.at)].sort((a, b) => a - b));
    const built = moments.find((moment) => moment.id === 'built');
    expect(built?.round).toBe(world.build.builtRound);
    expect(built?.note).toMatch(/after questions closed/);
  });

  it('marks what has not happened yet', () => {
    const moments = timeline(viewOf({ latest: { round: 50, error: null }, now: 0 }));
    expect(moments.find((moment) => moment.id === 'lock')?.happened).toBe(false);
  });

  it('is empty before the exam is on the record', () => {
    expect(timeline(viewOf({ records: { state: 'loading' } }))).toEqual([]);
  });

  it('says durations in plain words', () => {
    expect(duration(3)).toBe('3 seconds');
    expect(duration(60)).toBe('1 minute');
    expect(duration(190)).toBe('3 minutes 10 seconds');
    expect(duration(3660)).toBe('1 hour 1 minute');
  });
});

describe('identity', () => {
  const board = '0x000000000000000000000000000000000000b0a2' as const;
  const lookup = (name: string | null, address: `0x${string}` | null): Pick<EnsLookup, 'primaryName' | 'address'> => ({
    primaryName: () => Promise.resolve(name),
    address: () => Promise.resolve(address),
  });

  it('confirms the board’s name only both ways', async () => {
    expect(await readBoardName(board, lookup('board.eth', board))).toEqual({ state: 'confirmed', name: 'board.eth' });
    expect(await readBoardName(board, lookup('board.eth', '0x0000000000000000000000000000000000000001'))).toEqual({ state: 'unconfirmed', name: 'board.eth' });
    expect(await readBoardName(board, lookup(null, null))).toEqual({ state: 'none' });
  });

  it('shows a failed read as unread, and never throws', async () => {
    const down = { primaryName: () => Promise.reject(new Error('429')), address: () => Promise.resolve(null) };
    expect(await readBoardName(board, down)).toEqual({ state: 'unread', message: '429' });
  });

  it('finds a release only by its exact commit and image', () => {
    const commit = `0x${'a'.repeat(40)}` as Hex;
    const digest = `0x${'b'.repeat(64)}` as Hex;
    const body = '```json\n' + JSON.stringify({ version: 'v1.0.0', commit, imageDigest: digest }) + '\n```';
    const listing = [{ draft: false, tag_name: 'v1.0.0', html_url: 'https://github.com/o/r/releases/tag/v1.0.0', body }];
    expect(findVersion(listing, commit, digest)).toEqual({ state: 'found', version: 'v1.0.0', url: 'https://github.com/o/r/releases/tag/v1.0.0' });
    expect(findVersion(listing, commit, `0x${'c'.repeat(64)}`)).toEqual({ state: 'none' });
    expect(findVersion([{ ...listing[0], html_url: 'https://evil.example/' }], commit, digest)).toEqual({ state: 'none' });
    expect(findVersion('not a list', commit, digest)).toEqual({ state: 'none' });
  });

  it('looks for a name only in the index, and has none without one', async () => {
    const args = { writers: [writer], examId, registry: registryAddress, rpcUrl: 'https://rpc.example' };
    expect(await readExamName({ ...args, reader: null })).toEqual({ name: null, failed: 0 });
    const empty = { examRows: () => Promise.resolve([{ examId, name: '' }]) } as never;
    expect(await readExamName({ ...args, reader: empty })).toEqual({ name: null, failed: 0 });
    const down = { examRows: () => Promise.reject(new Error('429')) } as never;
    vi.useFakeTimers();
    const read = readExamName({ ...args, reader: down });
    await vi.advanceTimersByTimeAsync(6000);
    vi.useRealTimers();
    expect(await read).toMatchObject({ name: null, unread: '429' });
  });
});
