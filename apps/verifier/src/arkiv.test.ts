import type { ReleaseLogRow, ReleaseTokenRow } from '@paperseal/arkiv';
import type { Hex } from '@paperseal/protocol';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChainData } from './checks';
import { buildWorld, examId, p256, registryAddress, signedReleaseLog, type World } from './fixtures';
import { ARKIV_BLOCK_SECONDS, loadArkiv, type ArkivReport, type ArkivSource } from './load';

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

function readerOf(rows: { logs?: ReleaseLogRow[]; tokens?: ReleaseTokenRow[] }) {
  const reader = {
    releaseRows: vi.fn(() => Promise.resolve({ logs: rows.logs ?? [], tokens: rows.tokens ?? [] })),
    latestBlock: vi.fn(() => Promise.resolve(LATEST)),
  };
  return reader satisfies ArkivSource;
}

async function read(w: World, reader: ArkivSource, writers: Hex[] = [writer]): Promise<ArkivReport> {
  const report = await loadArkiv({ reader, chain: () => chainOf(w), examId, registry: registryAddress, writers, trustedRoot: w.pki.root });
  if ('kind' in report) throw new Error(report.message);
  return report;
}

describe('reading the Arkiv mirror', () => {
  it('shows a log once a release token attests the key that signed it', async () => {
    const report = await read(world, readerOf({ tokens: [tokenRow(world, 1)], logs: [logRow(world.releaseLog, 2, 9_940n)] }));
    expect(report.log).toMatchObject({ entityKey: keyOf(2), creator: writer, entries: 8 });
    expect(report.log?.progress?.count).toBe(8);
    expect(report.log?.verdict).toEqual({ examId: 'pass', entriesHash: 'pass', signature: 'pass' });
    expect(report.log?.writtenAt).toBe(LATEST.time - 60 * ARKIV_BLOCK_SECONDS);
    expect(report.ignored).toEqual({ tokens: 0, unreadable: 0, unattested: 0, failed: 0 });
    // The token row is the newest.
    expect(report.newestAt).toBe(LATEST.time - 10 * ARKIV_BLOCK_SECONDS);
  });

  it('asks only for rows from the writers the viewer trusts', async () => {
    const reader = readerOf({});
    await read(world, reader, [writer, otherWriter]);
    expect(reader.releaseRows).toHaveBeenCalledWith(examId, [writer, otherWriter]);
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
    const report = await loadArkiv({ reader, chain: () => other, examId, registry: registryAddress, writers: [writer], trustedRoot: world.pki.root });
    expect(report).toMatchObject({ log: null, ignored: { tokens: 1, unattested: 1 } });
  });

  it('reads nothing before the exam is on the public record', async () => {
    const reader = readerOf({});
    const report = await loadArkiv({ reader, chain: () => null, examId, registry: registryAddress, writers: [writer] });
    expect(report).toEqual({ kind: 'neutral', message: 'The exam is not on the public record yet.' });
    expect(reader.releaseRows).not.toHaveBeenCalled();
  });

  it('throws when Arkiv cannot be read, so the page says so and nothing fails', async () => {
    const reader = { ...readerOf({}), releaseRows: vi.fn(() => Promise.reject(new Error('rate limited'))) };
    await expect(read(world, reader)).rejects.toThrow('rate limited');
  });
});
