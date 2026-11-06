import { createPublicClient } from '@arkiv-network/sdk';
import { asc, eq, MAX_LIMIT, or } from '@arkiv-network/sdk/query';
import { addr } from '@arkiv-network/sdk/schema';
import { getAddress, hexToBytes, isAddressEqual, type Address, type Hex } from 'viem';

import { arkivChain, arkivTransport, examIdColumn, type ArkivConnection } from './client';
import { relayHeartbeatSchema, releaseLogSchema, releaseTokenSchema } from './schemas';

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

/**
 * A writer's sign of life (spec/arkiv.md, Reading, rule 4). It isn't evidence: only `createdAtBlock`
 * and `creator` matter, and the other columns are what the writer says, unchecked.
 */
export interface HeartbeatRow extends Omit<ArkivRow, 'body'> {
  /** The newest log's `entriesHash` the writer had seen, or `''` if none. */
  entriesHash: string;
  /** The TEE stage the writer last read, or `''`. */
  stage: string;
}

export interface ReleaseRows {
  logs: ReleaseLogRow[];
  tokens: ReleaseTokenRow[];
  heartbeats: HeartbeatRow[];
}

export interface ReleaseRowsOptions {
  /** Only rows for the exam in this `ExamRegistry`, as spec/arkiv.md, Reading, rule 1 asks. */
  registry?: Address | undefined;
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
   * The `release-log`, `release-token` and `relay-heartbeat` rows for one exam created by any of
   * `writers`, and only for `options.registry` when given. Anyone can write to Arkiv, so an empty
   * `writers` reads nothing rather than everything.
   */
  async function releaseRows(
    examId: Hex,
    writers: readonly Address[],
    options: ReleaseRowsOptions = {},
  ): Promise<ReleaseRows> {
    const id = examIdColumn(examId);
    // getAddress throws on a bad checksum, so a mistyped writer fails loudly instead of matching nobody.
    const trusted = new Set(writers.map((writer) => getAddress(writer)));
    const registry = options.registry === undefined ? undefined : getAddress(options.registry);
    if (trusted.size === 0) return { logs: [], tokens: [], heartbeats: [] };
    const byWriter = or([...trusted].map((writer) => eq('$creator', addr(writer))));
    const filters =
      registry === undefined
        ? [eq('examId', id), byWriter]
        : [eq('examId', id), eq('registry', addr(registry)), byWriter];
    // The query already filters by creator and registry; this keeps a misbehaving node from adding rows.
    const wanted = (row: { $creator: Hex; registry: { value: Address } }) =>
      trusted.has(getAddress(row.$creator)) && (registry === undefined || isAddressEqual(row.registry.value, registry));
    const columns = { $key: true, $creator: true, $createdAt: true, examId: true, registry: true } as const;

    const [logs, tokens, heartbeats] = await Promise.all([
      allPages((offset) =>
        client
          .select({ ...columns, entriesHash: true, body: true })
          .from(releaseLogSchema)
          .where(...filters)
          .orderBy(asc('$key'))
          .limit(MAX_LIMIT)
          .offset(offset)
          .fetch(),
      ),
      allPages((offset) =>
        client
          .select({ ...columns, instanceKeyHash: true, body: true })
          .from(releaseTokenSchema)
          .where(...filters)
          .orderBy(asc('$key'))
          .limit(MAX_LIMIT)
          .offset(offset)
          .fetch(),
      ),
      allPages((offset) =>
        client
          .select({ ...columns, entriesHash: true, stage: true })
          .from(relayHeartbeatSchema)
          .where(...filters)
          .orderBy(asc('$key'))
          .limit(MAX_LIMIT)
          .offset(offset)
          .fetch(),
      ),
    ]);

    const common = (
      row: (typeof logs)[number] | (typeof tokens)[number] | (typeof heartbeats)[number],
    ): Omit<ArkivRow, 'body'> => ({
      entityKey: row.$key,
      creator: getAddress(row.$creator),
      createdAtBlock: row.$createdAt,
      examId: row.examId.value,
      registry: getAddress(row.registry.value),
    });
    return {
      logs: logs.filter(wanted).map((row) => ({
        ...common(row),
        body: hexToBytes(row.body.value),
        entriesHash: row.entriesHash.value,
      })),
      tokens: tokens.filter(wanted).map((row) => ({
        ...common(row),
        body: hexToBytes(row.body.value),
        instanceKeyHash: row.instanceKeyHash.value,
      })),
      heartbeats: heartbeats
        .filter(wanted)
        .map((row) => ({ ...common(row), entriesHash: row.entriesHash.value, stage: row.stage.value })),
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
