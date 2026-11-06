import { describe, expect, it, vi } from 'vitest';

import { createBackupCache, withBackup, type BackupRowSource, type BackupSource } from './backup';
import { buildWorld, examId, registryAddress, type World } from './fixtures';

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
    expect(storage.use()).toEqual({ served: [], missed: [], ignored: { collections: 0, files: 0 } });
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

  it('serves unlock files only from an unlock backup, for the page to check', async () => {
    const world = await buildWorld();
    const swarm = swarmWith({ [ref(1)]: world.files, [ref(2)]: world.files });
    const backup = source([row(world, 2, { phase: 'build' })], swarm);
    const lost = { 'release-log.json': null, 'key-priv.tlock': null };
    expect(await withBackup(world.storage(lost), backup, world.build).get('release-log.json')).toBeNull();
    const storage = withBackup(world.storage(lost), source([row(world, 1), row(world, 2, { phase: 'build' })], swarm), world.build);
    expect(await storage.get('release-log.json')).toEqual(world.files.get('release-log.json'));
    expect(storage.use().served[0]).toMatchObject({ name: 'release-log.json', inManifest: false, swarmRef: ref(1) });
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
