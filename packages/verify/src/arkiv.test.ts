import type { HeartbeatRow, ReleaseLogRow, ReleaseTokenRow } from '@paperseal/arkiv';
import type { Hex } from '@paperseal/protocol';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChainData } from './checks';
import { buildWorld, examId, p256, registryAddress, signedReleaseLog, storageBucket, type World } from './fixtures';
import { ARKIV_BLOCK_SECONDS, ARKIV_STALE_AFTER_SECONDS, loadArkiv, type ArkivReport, type ArkivSource } from './load';

/*
 * The Arkiv reader is the one thing stubbed here. Every row body is a real token or a real signed
 * log from the fixture world, and is checked for real, against the fixture's own root in place of
 * Google's.
 */

const writer: Hex = '0x1111111111111111111111111111111111111111';
const otherWriter: Hex = '0x2222222222222222222222222222222222222222';
const LATEST = { number: 10_000n, time: 1_900_000_000 };

let world: World;
let badWorld: World;
beforeAll(async () => {
  [world, badWorld] = await Promise.all([buildWorld(), buildWorld({ badReleaseToken: true })]);
});

const bytes = (text: string) => new TextEncoder().encode(text);
const keyOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

const common = (n: number, block: bigint) => ({
  entityKey: keyOf(n),
  creator: writer,
  createdAtBlock: block,
  examId,
  registry: registryAddress,
});
function tokenRow(w: World, n: number, block = 9_990n): ReleaseTokenRow {
  const body = w.files.get('release-token.jwt');
  if (!body) throw new Error('no release token');
  return { ...common(n, block), instanceKeyHash: '0x', body };
}
function logRow(log: object, n: number, block = 9_990n): ReleaseLogRow {
  return { ...common(n, block), entriesHash: '0x', body: bytes(JSON.stringify(log)) };
}

const chainOf = (w: World): ChainData =>
  ({ exam: w.exam, build: w.build, list: { listHash: w.build.approvedListHash }, criteria: w.criteriaHex, entries: w.entriesHex }) as ChainData;

function heartbeatRow(n: number, block: bigint, stage = 'unlock'): HeartbeatRow {
  return { ...common(n, block), entriesHash: '', stage };
}

function readerOf(rows: { logs?: ReleaseLogRow[]; tokens?: ReleaseTokenRow[]; heartbeats?: HeartbeatRow[] }, latest = LATEST) {
  const reader = {
    releaseRows: vi.fn(() => Promise.resolve({ logs: rows.logs ?? [], tokens: rows.tokens ?? [], heartbeats: rows.heartbeats ?? [] })),
    latestBlock: vi.fn(() => Promise.resolve(latest)),
  };
  return reader satisfies ArkivSource;
}

async function read(w: World, reader: ArkivSource, writers: Hex[] = [writer]): Promise<ArkivReport> {
  const report = await loadArkiv({ reader, chain: () => chainOf(w), examId, registry: registryAddress, bucket: storageBucket, writers, trustedRoot: w.pki.root });
  if ('kind' in report) throw new Error(report.message);
  return report;
}

describe('reading the Arkiv mirror', () => {
  it('shows a log once a release token attests the key that signed it', async () => {
    const report = await read(world, readerOf({ tokens: [tokenRow(world, 1)], logs: [logRow(world.releaseLog, 2, 9_940n)] }));
    expect(report.log).toMatchObject({ entityKey: keyOf(2), creator: writer, entries: 8 });
    expect(report.log?.progress?.count).toBe(8);
    expect(report.log?.verdict).toEqual({ examId: 'pass', entriesHash: 'pass', filesHash: 'pass', signature: 'pass' });
    expect(report.log?.writtenAt).toBe(LATEST.time - 60 * ARKIV_BLOCK_SECONDS);
    expect(report.ignored).toEqual({ tokens: 0, unreadable: 0, unattested: 0, failed: 0 });
    // Tokens are not a sign of life, so the log row is the newest that counts.
    expect(report.newestAt).toBe(LATEST.time - 60 * ARKIV_BLOCK_SECONDS);
    expect(report.ageSeconds).toBe(60 * ARKIV_BLOCK_SECONDS);
    expect(report.heartbeat).toBeNull();
  });

  it('asks only for rows from the writers given, in the registry this view reads', async () => {
    const reader = readerOf({});
    await read(world, reader, [writer, otherWriter]);
    expect(reader.releaseRows).toHaveBeenCalledWith(examId, [writer, otherWriter], { registry: registryAddress });
  });

  it('shows the verified log with the most entries, as logs only grow', async () => {
    const earlier = await signedReleaseLog(world, 3);
    const report = await read(
      world,
      readerOf({ tokens: [tokenRow(world, 1)], logs: [logRow(earlier, 2, 9_999n), logRow(world.releaseLog, 3, 9_950n), logRow(earlier, 4)] }),
    );
    expect(report.log).toMatchObject({ entityKey: keyOf(3), entries: 8 });
    expect(report.ignored).toEqual({ tokens: 0, unreadable: 0, unattested: 0, failed: 0 });
  });

  it('ignores a log signed by a key that no passing token attests', async () => {
    const stranger = await p256();
    const forged = await signedReleaseLog(world, 8, stranger);
    const earlier = await signedReleaseLog(world, 2);
    const report = await read(world, readerOf({ tokens: [tokenRow(world, 1)], logs: [logRow(forged, 2), logRow(earlier, 3)] }));
    expect(report.log).toMatchObject({ entityKey: keyOf(3), entries: 2 });
    // The token attests the Unlock key, not the stranger's, so it still counts as passing.
    expect(report.ignored).toEqual({ tokens: 0, unreadable: 0, unattested: 1, failed: 0 });
  });

  it('ignores the logs of a token that fails its check', async () => {
    const report = await read(badWorld, readerOf({ tokens: [tokenRow(badWorld, 1)], logs: [logRow(badWorld.releaseLog, 2)] }));
    expect(report.log).toBeNull();
    expect(report.ignored).toEqual({ tokens: 1, unreadable: 0, unattested: 1, failed: 0 });
  });

  it('ignores a log with no token at all, and one that is not a release log', async () => {
    const report = await read(world, readerOf({ logs: [logRow(world.releaseLog, 2), { ...logRow({}, 3), body: bytes('not json') }] }));
    expect(report.log).toBeNull();
    expect(report.ignored).toEqual({ tokens: 0, unreadable: 1, unattested: 1, failed: 0 });
  });

  it('ignores an attested log whose entries were changed after signing', async () => {
    const changed = { ...world.releaseLog, entries: world.releaseLog.entries.slice(0, 7) };
    const report = await read(world, readerOf({ tokens: [tokenRow(world, 1)], logs: [logRow(changed, 2)] }));
    expect(report.log).toBeNull();
    expect(report.ignored.failed).toBe(1);
  });

  it('checks tokens against the exam on the public record, so another exam’s settings fail', async () => {
    const other = { ...chainOf(world), exam: { ...world.exam, imageDigest: `0x${'00'.repeat(32)}` } } as ChainData;
    const reader = readerOf({ tokens: [tokenRow(world, 1)], logs: [logRow(world.releaseLog, 2)] });
    const report = await loadArkiv({ reader, chain: () => other, examId, registry: registryAddress, bucket: storageBucket, writers: [writer], trustedRoot: world.pki.root });
    expect(report).toMatchObject({ log: null, ignored: { tokens: 1, unattested: 1 } });
  });

  it('reads nothing before the exam is on the public record', async () => {
    const reader = readerOf({});
    const report = await loadArkiv({ reader, chain: () => null, examId, registry: registryAddress, bucket: storageBucket, writers: [writer] });
    expect(report).toEqual({ kind: 'neutral', message: 'The exam is not on the public record yet.' });
    expect(reader.releaseRows).not.toHaveBeenCalled();
  });

  it('throws when Arkiv cannot be read, so the page says so and nothing fails', async () => {
    const reader = { ...readerOf({}), releaseRows: vi.fn(() => Promise.reject(new Error('rate limited'))) };
    await expect(read(world, reader)).rejects.toThrow('rate limited');
  });
});

describe('the mirror\'s last sign of life', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a fresh heartbeat, so a relay that only writes on change does not look stopped', async () => {
    const report = await read(
      world,
      readerOf({
        tokens: [tokenRow(world, 1, 9_995n)],
        logs: [logRow(world.releaseLog, 2, 9_000n)],
        heartbeats: [heartbeatRow(3, 9_970n, 'build'), heartbeatRow(4, 9_985n, 'unlock'), heartbeatRow(5, 9_950n)],
      }),
    );
    expect(report.ageSeconds).toBe(15 * ARKIV_BLOCK_SECONDS);
    expect(report.ageSeconds).toBeLessThan(ARKIV_STALE_AFTER_SECONDS);
    expect(report.newestAt).toBe(LATEST.time - 15 * ARKIV_BLOCK_SECONDS);
    expect(report.heartbeat).toEqual({ creator: writer, createdAtBlock: 9_985n, writtenAt: LATEST.time - 15 * ARKIV_BLOCK_SECONDS, stage: 'unlock' });
    expect(report.read).toEqual({ logs: 1, tokens: 1, heartbeats: 3 });
  });

  it('never lets a heartbeat move progress or count as evidence', async () => {
    const earlier = await signedReleaseLog(world, 3);
    const rows = { tokens: [tokenRow(world, 1)], logs: [logRow(earlier, 2)] };
    const without = await read(world, readerOf(rows));
    const withBeats = await read(world, readerOf({ ...rows, heartbeats: [heartbeatRow(3, 9_999n, 'complete')] }));
    expect(withBeats.log).toEqual(without.log);
    expect(withBeats.log?.progress?.count).toBe(3);
    expect(withBeats.ignored).toEqual(without.ignored);
  });

  it('times the newest row by Arkiv blocks alone, whatever this device\'s clock says', async () => {
    const rows = { logs: [logRow(world.releaseLog, 2, 9_000n)], heartbeats: [heartbeatRow(3, 9_100n)] };
    const ages: (number | null)[] = [];
    for (const deviceTime of ['2001-01-01T00:00:00Z', '2099-12-31T00:00:00Z']) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(deviceTime));
      ages.push((await read(world, readerOf(rows))).ageSeconds);
      vi.useRealTimers();
    }
    expect(ages).toEqual([900 * ARKIV_BLOCK_SECONDS, 900 * ARKIV_BLOCK_SECONDS]);
    expect(ages[0]).toBeGreaterThan(ARKIV_STALE_AFTER_SECONDS);
  });

  it('has no sign of life with no heartbeat or log row, even with a token', async () => {
    const report = await read(world, readerOf({ tokens: [tokenRow(world, 1)] }));
    expect(report.ageSeconds).toBeNull();
    expect(report.newestAt).toBeNull();
    expect(report.heartbeat).toBeNull();
  });
});
