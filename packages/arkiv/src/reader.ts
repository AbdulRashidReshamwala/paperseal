import { createPublicClient } from '@arkiv-network/sdk';
import { asc, eq, MAX_LIMIT, or } from '@arkiv-network/sdk/query';
import { addr } from '@arkiv-network/sdk/schema';
import { getAddress, hexToBytes, type Address, type Hex } from 'viem';

import { arkivChain, arkivTransport, examIdColumn, type ArkivConnection } from './client';
import { releaseLogSchema, releaseTokenSchema } from './schemas';

/**
 * What every row carries. `creator` is the Arkiv `$creator`, which never changes; callers show it
 * next to the row. `body` is the evidence itself: callers parse and check it, and trust the other
 * columns only to find rows.
 */
export interface ArkivRow {
  entityKey: Hex;
  creator: Address;
  /** The block the row was created in. Rabdi blocks are 2 seconds apart. */
  createdAtBlock: bigint;
  examId: string;
  registry: Address;
  body: Uint8Array;
}

export interface ReleaseLogRow extends ArkivRow {
  entriesHash: string;
}

export interface ReleaseTokenRow extends ArkivRow {
  instanceKeyHash: string;
}

export type ArkivReaderOptions = ArkivConnection;

/** One page of a query: its rows, and how many matches it left out for not fitting the schema. */
interface Page<R> {
  entities: readonly R[];
  skipped: number;
}

/**
 * Reads every page of a query sorted by `$key`. The node counts skipped entities toward the offset,
 * so the next page starts past both, and a page that covered less than a full page was the last.
 * A row created mid-walk can shift a later page, so rows are deduplicated by key.
 */
async function allPages<R extends { $key: Hex }>(
  fetchPage: (offset: number) => Promise<Page<R>>,
): Promise<R[]> {
  const rows = new Map<Hex, R>();
  for (let offset = 0; ; ) {
    const { entities, skipped } = await fetchPage(offset);
    for (const row of entities) rows.set(row.$key, row);
    const covered = entities.length + skipped;
    if (covered < MAX_LIMIT) return [...rows.values()];
    offset += covered;
  }
}

export function createArkivReader(options: ArkivReaderOptions = {}) {
  const client = createPublicClient({
    chain: arkivChain(options.accessKey),
    transport: arkivTransport(options),
  });

  /**
   * The `release-log` and `release-token` rows for one exam created by any of `writers`. Anyone
   * can write to Arkiv, so an empty `writers` reads nothing rather than everything.
   */
  async function releaseRows(
    examId: Hex,
    writers: readonly Address[],
  ): Promise<{ logs: ReleaseLogRow[]; tokens: ReleaseTokenRow[] }> {
    const id = examIdColumn(examId);
    // getAddress throws on a bad checksum, so a mistyped writer fails loudly instead of matching nobody.
    const trusted = new Set(writers.map((writer) => getAddress(writer)));
    if (trusted.size === 0) return { logs: [], tokens: [] };
    const byWriter = or([...trusted].map((writer) => eq('$creator', addr(writer))));
    // The query already filters by creator; this keeps a misbehaving node from adding rows.
    const fromWriter = (row: { $creator: Hex }) => trusted.has(getAddress(row.$creator));

    const [logs, tokens] = await Promise.all([
      allPages((offset) =>
        client
          .select({
            $key: true,
            $creator: true,
            $createdAt: true,
            examId: true,
            registry: true,
            entriesHash: true,
            body: true,
          })
          .from(releaseLogSchema)
          .where(eq('examId', id), byWriter)
          .orderBy(asc('$key'))
          .limit(MAX_LIMIT)
          .offset(offset)
          .fetch(),
      ),
      allPages((offset) =>
        client
          .select({
            $key: true,
            $creator: true,
            $createdAt: true,
            examId: true,
            registry: true,
            instanceKeyHash: true,
            body: true,
          })
          .from(releaseTokenSchema)
          .where(eq('examId', id), byWriter)
          .orderBy(asc('$key'))
          .limit(MAX_LIMIT)
          .offset(offset)
          .fetch(),
      ),
    ]);

    const common = (row: (typeof logs)[number] | (typeof tokens)[number]): ArkivRow => ({
      entityKey: row.$key,
      creator: getAddress(row.$creator),
      createdAtBlock: row.$createdAt,
      examId: row.examId.value,
      registry: getAddress(row.registry.value),
      body: hexToBytes(row.body.value),
    });
    return {
      logs: logs.filter(fromWriter).map((row) => ({ ...common(row), entriesHash: row.entriesHash.value })),
      tokens: tokens
        .filter(fromWriter)
        .map((row) => ({ ...common(row), instanceKeyHash: row.instanceKeyHash.value })),
    };
  }

  /** Arkiv's latest block and its time in Unix seconds, to tell how long ago a row was written. */
  async function latestBlock(): Promise<{ number: bigint; time: number }> {
    const { currentBlock, currentBlockTime } = await client.getBlockTiming();
    return { number: currentBlock, time: currentBlockTime };
  }

  return { releaseRows, latestBlock };
}

export type ArkivReader = ReturnType<typeof createArkivReader>;
