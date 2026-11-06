import { describe, expect, it, vi } from 'vitest';

import { createBackupCache, withBackup, type BackupRowSource, type BackupSource } from './backup';
import type { ChainData } from './checks';
import { buildWorld, examId, registryAddress, type World } from './fixtures';
import { loadRecords } from './load';
import { runProof } from './proof';

const writer = '0x1111111111111111111111111111111111111111';
const ref = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const api = 'http://bee.example:1633';

type Row = Awaited<ReturnType<BackupRowSource['backupRows']>>[number];

function row(world: World, n: number, over: Partial<Row> = {}): Row {
  return {
    entityKey: `0x${n.toString(16).padStart(64, '0')}`,
    creator: writer,
    createdAtBlock: BigInt(n),
    examId,
    registry: registryAddress,
    phase: 'unlock',
    swarmRef: ref(n),
    swarmNetwork: 'sepolia',
    manifestHash: world.build.storageManifestHash,
    files: world.files.size,
    batchId: 'cd'.repeat(32),
    ...over,
  };
}

/** A Swarm node holding `collections`, by reference. A collection left out is not on the node. */
function swarmWith(collections: Record<string, Map<string, Uint8Array>>) {
  return {
    download: vi.fn((reference: string, path: string) => Promise.resolve(collections[reference]?.get(path) ?? null)),
  };
}

function source(rows: Row[] | Error, swarm: BackupSource['swarm']): BackupSource & { rows: { backupRows: ReturnType<typeof vi.fn> } } {
  return {
    rows: { backupRows: vi.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows))) },
    swarm,
    swarmApiUrl: `${api}/`,
    writers: [writer],
    examId,
    registry: registryAddress,
    cache: createBackupCache(),
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('the Swarm backup', () => {
  it('reads nothing from Arkiv or Swarm while the bucket gives every file and each matches', async () => {
    const world = await buildWorld();
    const swarm = swarmWith({});
    const backup = source([row(world, 1)], swarm);
    const storage = withBackup(world.storage(), backup, world.build);
    for (const name of ['manifest.json', 'token.jwt', 'paper.bin', 'key-pub.tlock', 'key-priv.tlock', 'release-log.json']) {
      expect(await storage.get(name)).toEqual(world.files.get(name));
    }
    expect(backup.rows.backupRows).not.toHaveBeenCalled();
    expect(swarm.download).not.toHaveBeenCalled();
    expect(storage.use()).toEqual({ served: [], missed: [], ignored: { collections: 0, files: 0 }, rejected: [] });
  });

  it('serves a file the bucket lost from a backup whose manifest matches the Build', async () => {
    const world = await buildWorld();
    const swarm = swarmWith({ [ref(1)]: world.files });
    const backup = source([row(world, 1)], swarm);
    const storage = withBackup(world.storage({ 'manifest.json': null, 'paper.bin': null }), backup, world.build);
    expect(await storage.get('paper.bin')).toEqual(world.files.get('paper.bin'));
    expect(await storage.get('manifest.json')).toEqual(world.files.get('manifest.json'));
    expect(backup.rows.backupRows).toHaveBeenCalledWith(examId, [writer], { registry: registryAddress });
    const served = storage.use().served;
    expect(served.map((file) => file.name).sort()).toEqual(['manifest.json', 'paper.bin']);
    expect(served.find((file) => file.name === 'paper.bin')).toEqual({
      name: 'paper.bin',
      swarmRef: ref(1),
      entityKey: row(world, 1).entityKey,
      phase: 'unlock',
      url: `${api}/bzz/${ref(1)}/paper.bin`,
      inManifest: true,
      bucket: 'missing',
    });
  });

  it("replaces a bucket file that fails its hash in the record's manifest", async () => {
    const world = await buildWorld();
    const swarm = swarmWith({ [ref(1)]: world.files });
    const storage = withBackup(world.storage({ 'paper.bin': bytes('tampered') }), source([row(world, 1)], swarm), world.build);
    expect(await storage.get('paper.bin')).toEqual(world.files.get('paper.bin'));
    expect(storage.use().served[0]?.bucket).toBe('mismatch');
  });

  it('replaces a bucket manifest that does not match the Build', async () => {
    const world = await buildWorld();
    const swarm = swarmWith({ [ref(1)]: world.files });
    const storage = withBackup(world.storage({ 'manifest.json': bytes('{}') }), source([row(world, 1)], swarm), world.build);
    expect(await storage.get('manifest.json')).toEqual(world.files.get('manifest.json'));
  });

  it("rejects a collection whose manifest does not hash to the Build's, whatever its row says", async () => {
    const world = await buildWorld();
    const forged = new Map(world.files);
    forged.set('manifest.json', bytes(JSON.stringify({ ...world.manifest, files: [] })));
    const swarm = swarmWith({ [ref(1)]: forged, [ref(2)]: world.files });
    const backup = source([row(world, 1), row(world, 2, { manifestHash: `0x${'00'.repeat(32)}` })], swarm);
    const storage = withBackup(world.storage({ 'paper.bin': null }), backup, world.build);
    expect(await storage.get('paper.bin')).toBeNull();
    // The row that names another manifest is never read from Swarm at all.
    expect(swarm.download.mock.calls.map(([reference]) => reference)).toEqual([ref(1)]);
    expect(storage.use()).toEqual({
      served: [],
      missed: [{ name: 'paper.bin', kind: 'none', reason: 'No backup that passed its check holds this file' }],
      ignored: { collections: 2, files: 0 },
      rejected: [],
    });
  });

  it('ignores a backed-up file that does not match its manifest, and tries the next backup', async () => {
    const world = await buildWorld();
    const bad = new Map(world.files);
    bad.set('paper.bin', bytes('tampered'));
    const swarm = swarmWith({ [ref(1)]: bad, [ref(2)]: world.files });
    const storage = withBackup(world.storage({ 'paper.bin': null }), source([row(world, 1), row(world, 2)], swarm), world.build);
    expect(await storage.get('paper.bin')).toEqual(world.files.get('paper.bin'));
    expect(storage.use().served[0]?.swarmRef).toBe(ref(2));
    expect(storage.use().ignored).toEqual({ collections: 0, files: 1 });

    const alone = withBackup(world.storage({ 'paper.bin': null }), source([row(world, 1)], swarmWith({ [ref(1)]: bad })), world.build);
    expect(await alone.get('paper.bin')).toBeNull();
  });

  it("keeps the bucket's failing copy when no backup passes, so the page's own check shows it", async () => {
    const world = await buildWorld();
    const storage = withBackup(world.storage({ 'paper.bin': bytes('tampered') }), source([], swarmWith({})), world.build);
    expect(await storage.get('paper.bin')).toEqual(bytes('tampered'));
  });

  it('serves unlock files only from an unlock backup, and only once they pass the check given', async () => {
    const world = await buildWorld();
    const swarm = swarmWith({ [ref(1)]: world.files, [ref(2)]: world.files });
    const pass = (bytes: Uint8Array) => Promise.resolve({ pass: true, value: bytes });
    const lost = { 'release-log.json': null, 'key-priv.tlock': null };
    const buildOnly = withBackup(world.storage(lost), source([row(world, 2, { phase: 'build' })], swarm), world.build);
    expect(await buildOnly.checked('release-log.json', pass)).toBeNull();
    const storage = withBackup(world.storage(lost), source([row(world, 1), row(world, 2, { phase: 'build' })], swarm), world.build);
    expect(await storage.checked('release-log.json', pass)).toEqual(world.files.get('release-log.json'));
    expect(storage.use().served[0]).toMatchObject({ name: 'release-log.json', inManifest: false, swarmRef: ref(1) });
    // A plain read never takes an unlock file from a backup, since nothing there has checked it.
    expect(await storage.get('key-priv.tlock')).toBeNull();
  });

  it('says a backup was not read, and gives the bucket answer, when Swarm or Arkiv does not answer', async () => {
    const world = await buildWorld();
    const down = { download: vi.fn(() => Promise.reject(new Error('GET /bzz: no response from the Bee node'))) };
    const storage = withBackup(world.storage({ 'paper.bin': null }), source([row(world, 1)], down), world.build);
    expect(await storage.get('paper.bin')).toBeNull();
    expect(storage.use().missed).toEqual([
      { name: 'paper.bin', kind: 'not-read', reason: 'The backup could not be read: GET /bzz: no response from the Bee node' },
    ]);

    const noArkiv = withBackup(world.storage({ 'paper.bin': null }), source(new Error('rate limited'), swarmWith({})), world.build);
    expect(await noArkiv.get('paper.bin')).toBeNull();
    expect(noArkiv.use().missed[0]).toMatchObject({ kind: 'not-read', reason: 'The copy on Arkiv could not be read: rate limited' });
  });

  it('rethrows an unreachable bucket when the backup does not have the file either', async () => {
    const world = await buildWorld();
    const broken = { url: () => '', get: () => Promise.reject(new Error('The public files returned error 503')) };
    await expect(withBackup(broken, source([], swarmWith({})), world.build).get('paper.bin')).rejects.toThrow(/503/);
    const backed = withBackup(broken, source([row(world, 1)], swarmWith({ [ref(1)]: world.files })), world.build);
    expect(await backed.get('paper.bin')).toEqual(world.files.get('paper.bin'));
    expect(backed.use().served[0]?.bucket).toBe('unreadable');
  });

  it('reads no backup without a Build to check it against, or without writers', async () => {
    const world = await buildWorld();
    const swarm = swarmWith({ [ref(1)]: world.files });
    const backup = source([row(world, 1)], swarm);
    expect(await withBackup(world.storage({ 'paper.bin': null }), backup, null).get('paper.bin')).toBeNull();
    expect(await withBackup(world.storage({ 'paper.bin': null }), { ...backup, writers: [] }, world.build).get('paper.bin')).toBeNull();
    expect(await withBackup(world.storage({ 'paper.bin': null }), null, world.build).get('paper.bin')).toBeNull();
    expect(backup.rows.backupRows).not.toHaveBeenCalled();
    expect(swarm.download).not.toHaveBeenCalled();
  });

  it('keeps what Swarm gave for each reference across reads', async () => {
    const world = await buildWorld();
    const swarm = swarmWith({ [ref(1)]: world.files });
    const backup = source([row(world, 1)], swarm);
    for (let i = 0; i < 2; i += 1) {
      expect(await withBackup(world.storage({ 'paper.bin': null }), backup, world.build).get('paper.bin')).toEqual(world.files.get('paper.bin'));
    }
    expect(swarm.download.mock.calls).toEqual([
      [ref(1), 'manifest.json'],
      [ref(1), 'paper.bin'],
    ]);
  });
});

describe('unlock files from the Swarm backup', () => {
  const chainOf = (w: World): ChainData =>
    ({ exam: w.exam, build: w.build, list: { listHash: w.build.approvedListHash }, criteria: w.criteriaHex, entries: w.entriesHex }) as ChainData;
  const proof = (w: World, storage: Parameters<typeof runProof>[0]['storage']) =>
    runProof({ storage, examId, exam: w.exam, build: w.build, criteria: w.criteriaHex, currentRound: 1000, keyPrivSha256: null, now: 2_000_000_000, client: w.client });
  /** The world's files with some replaced, as a backup collection. */
  const withFiles = (w: World, replace: Record<string, Uint8Array>) => new Map([...w.files, ...Object.entries(replace)]);

  it('skips a junk key-priv.tlock in the newest backup and opens the paper with an older one', async () => {
    const world = await buildWorld();
    const swarm = swarmWith({ [ref(2)]: withFiles(world, { 'key-priv.tlock': bytes('junk') }), [ref(1)]: world.files });
    const storage = withBackup(world.storage({ 'key-priv.tlock': null }), source([row(world, 2), row(world, 1)], swarm), world.build);
    const result = await proof(world, storage);
    if (result.state !== 'opened') throw new Error(`expected opened, got ${result.state}`);
    expect(Object.values(result.checks)).toEqual(Array(7).fill('pass'));
    const use = storage.use();
    expect(use.served).toEqual([expect.objectContaining({ name: 'key-priv.tlock', swarmRef: ref(1), entityKey: row(world, 1).entityKey, bucket: 'missing' })]);
    expect(use.rejected).toEqual([{ name: 'key-priv.tlock', swarmRef: ref(2), entityKey: row(world, 2).entityKey, reason: expect.any(String) as string }]);
    expect(use.missed).toEqual([]);
  });

  it('skips a key-priv.tlock that opens to another paper, since only the salted hash proves the key', async () => {
    const world = await buildWorld();
    const wrong = new TextEncoder().encode(await world.seal(new Uint8Array(32).fill(7)));
    const swarm = swarmWith({ [ref(2)]: withFiles(world, { 'key-priv.tlock': wrong }), [ref(1)]: world.files });
    const storage = withBackup(world.storage({ 'key-priv.tlock': null }), source([row(world, 2), row(world, 1)], swarm), world.build);
    expect((await proof(world, storage)).state).toBe('opened');
    expect(storage.use().rejected.map((copy) => copy.swarmRef)).toEqual([ref(2)]);
  });

  it('is only "not read", never a failure, when every backup copy of key-priv.tlock is junk', async () => {
    const world = await buildWorld();
    const junk = withFiles(world, { 'key-priv.tlock': bytes('junk') });
    const swarm = swarmWith({ [ref(2)]: junk, [ref(1)]: junk });
    const storage = withBackup(world.storage({ 'key-priv.tlock': null }), source([row(world, 2), row(world, 1)], swarm), world.build);
    // As if the backup were not there: the bucket has no key-priv.tlock, so the paper stays sealed.
    expect(await proof(world, storage)).toEqual({ state: 'sealed' });
    const use = storage.use();
    expect(use.served).toEqual([]);
    expect(use.rejected.map((copy) => copy.swarmRef)).toEqual([ref(2), ref(1)]);
    expect(use.missed).toEqual([
      { name: 'key-priv.tlock', kind: 'not-read', reason: '2 copies in the backup did not pass the checks in this step, so none was used.' },
    ]);
  });

  it("still fails the bucket's own junk key-priv.tlock, and reads no backup for it", async () => {
    const world = await buildWorld();
    const swarm = swarmWith({ [ref(1)]: world.files });
    const backup = source([row(world, 1)], swarm);
    const storage = withBackup(world.storage({ 'key-priv.tlock': bytes('junk') }), backup, world.build);
    expect(await proof(world, storage)).toMatchObject({ state: 'failed', step: 'timelock' });
    expect(storage.use()).toEqual({ served: [], missed: [], ignored: { collections: 0, files: 0 }, rejected: [] });
    expect(swarm.download).not.toHaveBeenCalled();
  });

  it('skips a junk release-log.json in the newest backup and uses the older one, with its token', async () => {
    const world = await buildWorld();
    const swarm = swarmWith({ [ref(2)]: withFiles(world, { 'release-log.json': bytes('{"not": "a log"}') }), [ref(1)]: world.files });
    for (const lost of [{ 'release-log.json': null }, { 'release-log.json': null, 'release-token.jwt': null }]) {
      const records = await loadRecords({
        chain: () => Promise.resolve(chainOf(world)),
        storage: world.storage(lost),
        examId,
        registry: registryAddress,
        backup: source([row(world, 2), row(world, 1)], swarm),
        trustedRoot: world.pki.root,
      });
      if (records.log.kind !== 'ready') throw new Error(`expected a log, got ${records.log.kind}`);
      expect(records.log.verdict).toMatchObject({ examId: 'pass', entriesHash: 'pass', signature: 'pass' });
      expect(records.log.token?.verified).toBe(true);
      const use = records.backup;
      expect(use?.served.find((file) => file.name === 'release-log.json')?.swarmRef).toBe(ref(1));
      expect(use?.rejected).toEqual([
        { name: 'release-log.json', swarmRef: ref(2), entityKey: row(world, 2).entityKey, reason: 'release-log.json does not have the release log shape.' },
      ]);
      // The token is reported only for the log that was used, so ref(2)'s honest token is never "rejected".
      if ('release-token.jwt' in lost) expect(use?.served.find((file) => file.name === 'release-token.jwt')?.swarmRef).toBe(ref(2));
    }
  });

  it('skips a backup release log that no token attests', async () => {
    const world = await buildWorld();
    const forged = { ...world.releaseLog, teeSignature: `0x${'00'.repeat(64)}` };
    const swarm = swarmWith({ [ref(2)]: withFiles(world, { 'release-log.json': bytes(JSON.stringify(forged)) }), [ref(1)]: world.files });
    const records = await loadRecords({
      chain: () => Promise.resolve(chainOf(world)),
      storage: world.storage({ 'release-log.json': null }),
      examId,
      registry: registryAddress,
      backup: source([row(world, 2), row(world, 1)], swarm),
      trustedRoot: world.pki.root,
    });
    if (records.log.kind !== 'ready') throw new Error(`expected a log, got ${records.log.kind}`);
    expect(records.log.verdict.signature).toBe('pass');
    expect(records.backup?.rejected.map((copy) => copy.swarmRef)).toEqual([ref(2)]);
  });

  it("is neutral when every backup release log is junk, and still fails the bucket's own junk log", async () => {
    const world = await buildWorld();
    const junk = withFiles(world, { 'release-log.json': bytes('junk') });
    const read = (bucket: Record<string, Uint8Array | null>, collections: Record<string, Map<string, Uint8Array>>) =>
      loadRecords({
        chain: () => Promise.resolve(chainOf(world)),
        storage: world.storage(bucket),
        examId,
        registry: registryAddress,
        backup: source([row(world, 2), row(world, 1)], swarmWith(collections)),
        trustedRoot: world.pki.root,
      });
    const allJunk = await read({ 'release-log.json': null }, { [ref(2)]: junk, [ref(1)]: junk });
    expect(allJunk.log.kind).toBe('neutral');
    expect(allJunk.backup?.missed).toEqual([expect.objectContaining({ name: 'release-log.json', kind: 'not-read' })]);
    expect(allJunk.backup?.rejected).toHaveLength(2);

    const badBucket = await read({ 'release-log.json': bytes('junk') }, { [ref(2)]: world.files, [ref(1)]: world.files });
    expect(badBucket.log).toEqual({ kind: 'malformed', message: 'release-log.json is not valid JSON.' });
    expect(badBucket.backup?.served).toEqual([]);
  });
});
