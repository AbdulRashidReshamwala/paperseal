import { createPublicClient } from '@arkiv-network/sdk';
import { asc, eq, MAX_LIMIT, or } from '@arkiv-network/sdk/query';
import { addr } from '@arkiv-network/sdk/schema';
import { getAddress, hexToBytes, isAddressEqual, type Address, type Hex } from 'viem';

import { arkivChain, arkivTransport, examIdColumn, type ArkivConnection } from './client';
import { allPages } from './pages';
import {
  backupSchema,
  examSchema,
  participantSchema,
  relayHeartbeatSchema,
  releaseLogSchema,
  releaseTokenSchema,
} from './schemas';

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

/**
 * An exam-index row (spec/arkiv.md, "Exam Index"). Every column is what the writer says: callers
 * check the exam against Sepolia before showing it, and the name against "Exam Names".
 */
export interface ExamRow {
  entityKey: Hex;
  creator: Address;
  createdAtBlock: bigint;
  examId: string;
  registry: Address;
  board: Address;
  chainId: bigint;
  /** `published`, `listed` or `built` from a well-behaved writer, but unchecked. */
  stage: string;
  examStart: bigint;
  createdBlock: bigint;
  criteriaHash: string;
  /** `''` before `ApprovedListPosted`. */
  approvedListHash: string;
  /** `''` before `BuildPosted`. */
  paperHash: string;
  /** `''` without a name. */
  name: string;
}

/** A participant-index row. Callers check the entry is in the exam's approved list on Sepolia. */
export interface ParticipantRow {
  entityKey: Hex;
  creator: Address;
  createdAtBlock: bigint;
  examId: string;
  registry: Address;
  role: string;
  owner: string;
  passkeyKeyHash: string;
  /** `''` for a setter. */
  derivedKeyHash: string;
}

/** What to look participants up by. At least one is required. */
export interface ParticipantQuery {
  registry?: Address | undefined;
  owner?: string | undefined;
  /** SHA-256 of the passkey public key, `0x` hex. */
  passkeyKeyHash?: string | undefined;
}

/**
 * A backup row (spec/arkiv.md, "Backups"). Every column is what the writer says: callers use the
 * collection only if its `manifest.json` hashes to the Build's `storageManifestHash` on Sepolia.
 */
export interface BackupRow {
  entityKey: Hex;
  creator: Address;
  createdAtBlock: bigint;
  examId: string;
  registry: Address;
  phase: 'build' | 'unlock';
  /** 64 lowercase hex characters, no `0x`. */
  swarmRef: string;
  swarmNetwork: string;
  manifestHash: string;
  files: number;
  batchId: string;
}

export type BackupRowsOptions = ReleaseRowsOptions;

export type ArkivReaderOptions = ArkivConnection;

/** The writers to read from, checksummed. A mistyped writer throws instead of matching nobody. */
const trustedSet = (writers: readonly Address[]) => new Set(writers.map((writer) => getAddress(writer)));
const byCreator = (trusted: ReadonlySet<Address>) => or([...trusted].map((writer) => eq('$creator', addr(writer))));

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
    const trusted = trustedSet(writers);
    const registry = options.registry === undefined ? undefined : getAddress(options.registry);
    if (trusted.size === 0) return { logs: [], tokens: [], heartbeats: [] };
    const byWriter = byCreator(trusted);
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

  /**
   * Every `exam` row for `registry` created by any of `writers`. Rows for other registries are
   * never requested, and any a node returns anyway are dropped.
   */
  async function examRows(registry: Address, writers: readonly Address[]): Promise<ExamRow[]> {
    const wantedRegistry = getAddress(registry);
    const trusted = trustedSet(writers);
    if (trusted.size === 0) return [];
    const rows = await allPages((offset) =>
      client
        .select({
          $key: true,
          $creator: true,
          $createdAt: true,
          examId: true,
          registry: true,
          board: true,
          chainId: true,
          stage: true,
          examStart: true,
          createdBlock: true,
          criteriaHash: true,
          approvedListHash: true,
          paperHash: true,
          name: true,
        })
        .from(examSchema)
        .where(eq('registry', addr(wantedRegistry)), byCreator(trusted))
        .orderBy(asc('$key'))
        .limit(MAX_LIMIT)
        .offset(offset)
        .fetch(),
    );
    return rows
      .filter((row) => trusted.has(getAddress(row.$creator)) && isAddressEqual(row.registry.value, wantedRegistry))
      .map((row) => ({
        entityKey: row.$key,
        creator: getAddress(row.$creator),
        createdAtBlock: row.$createdAt,
        examId: row.examId.value,
        registry: getAddress(row.registry.value),
        board: getAddress(row.board.value),
        chainId: row.chainId.value,
        stage: row.stage.value,
        examStart: row.examStart.value,
        createdBlock: row.createdBlock.value,
        criteriaHash: row.criteriaHash.value,
        approvedListHash: row.approvedListHash.value,
        paperHash: row.paperHash.value,
        name: row.name.value,
      }));
  }

  /**
   * The `participant` rows matching every filter in `query`, created by any of `writers`. The
   * node's answer is filtered again here, so it can't add rows that don't match.
   */
  async function participantRows(query: ParticipantQuery, writers: readonly Address[]): Promise<ParticipantRow[]> {
    const registry = query.registry === undefined ? undefined : getAddress(query.registry);
    const { owner } = query;
    let passkeyKeyHash: string | undefined;
    if (query.passkeyKeyHash !== undefined) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(query.passkeyKeyHash)) {
        throw new TypeError(`passkeyKeyHash must be 32 bytes of hex, got ${query.passkeyKeyHash}`);
      }
      passkeyKeyHash = query.passkeyKeyHash.toLowerCase();
    }
    if (registry === undefined && owner === undefined && passkeyKeyHash === undefined) {
      throw new TypeError('participantRows needs a registry, owner or passkeyKeyHash');
    }
    const trusted = trustedSet(writers);
    if (trusted.size === 0) return [];
    const filters = [
      ...(registry === undefined ? [] : [eq('registry', addr(registry))]),
      ...(owner === undefined ? [] : [eq('owner', owner)]),
      ...(passkeyKeyHash === undefined ? [] : [eq('passkeyKeyHash', passkeyKeyHash)]),
      byCreator(trusted),
    ];
    const rows = await allPages((offset) =>
      client
        .select({
          $key: true,
          $creator: true,
          $createdAt: true,
          examId: true,
          registry: true,
          role: true,
          owner: true,
          passkeyKeyHash: true,
          derivedKeyHash: true,
        })
        .from(participantSchema)
        .where(...filters)
        .orderBy(asc('$key'))
        .limit(MAX_LIMIT)
        .offset(offset)
        .fetch(),
    );
    return rows
      .filter(
        (row) =>
          trusted.has(getAddress(row.$creator)) &&
          (registry === undefined || isAddressEqual(row.registry.value, registry)) &&
          (owner === undefined || row.owner.value === owner) &&
          (passkeyKeyHash === undefined || row.passkeyKeyHash.value === passkeyKeyHash),
      )
      .map((row) => ({
        entityKey: row.$key,
        creator: getAddress(row.$creator),
        createdAtBlock: row.$createdAt,
        examId: row.examId.value,
        registry: getAddress(row.registry.value),
        role: row.role.value,
        owner: row.owner.value,
        passkeyKeyHash: row.passkeyKeyHash.value,
        derivedKeyHash: row.derivedKeyHash.value,
      }));
  }

  /**
   * The `backup` rows for one exam created by any of `writers`, and only for `options.registry`
   * when given, `unlock` before `build` and the newest first (spec/arkiv.md, "Backups", "Reading",
   * rule 1). Rows with another phase, or a reference that isn't a plain 64-character one, are
   * dropped, as are any a node returns that the query didn't ask for.
   */
  async function backupRows(
    examId: Hex,
    writers: readonly Address[],
    options: BackupRowsOptions = {},
  ): Promise<BackupRow[]> {
    const id = examIdColumn(examId);
    const trusted = trustedSet(writers);
    const registry = options.registry === undefined ? undefined : getAddress(options.registry);
    if (trusted.size === 0) return [];
    const filters =
      registry === undefined
        ? [eq('examId', id), byCreator(trusted)]
        : [eq('examId', id), eq('registry', addr(registry)), byCreator(trusted)];
    const rows = await allPages((offset) =>
      client
        .select({
          $key: true,
          $creator: true,
          $createdAt: true,
          examId: true,
          registry: true,
          phase: true,
          swarmRef: true,
          swarmNetwork: true,
          manifestHash: true,
          files: true,
          batchId: true,
        })
        .from(backupSchema)
        .where(...filters)
        .orderBy(asc('$key'))
        .limit(MAX_LIMIT)
        .offset(offset)
        .fetch(),
    );
    const rank = (phase: string) => (phase === 'unlock' ? 0 : 1);
    return rows
      .filter(
        (row) =>
          trusted.has(getAddress(row.$creator)) &&
          row.examId.value === id &&
          (registry === undefined || isAddressEqual(row.registry.value, registry)) &&
          (row.phase.value === 'build' || row.phase.value === 'unlock') &&
          /^[0-9a-f]{64}$/.test(row.swarmRef.value),
      )
      .sort(
        (a, b) =>
          rank(a.phase.value) - rank(b.phase.value) ||
          (a.$createdAt === b.$createdAt ? 0 : a.$createdAt > b.$createdAt ? -1 : 1) ||
          (a.$key < b.$key ? 1 : a.$key > b.$key ? -1 : 0),
      )
      .map((row) => ({
        entityKey: row.$key,
        creator: getAddress(row.$creator),
        createdAtBlock: row.$createdAt,
        examId: row.examId.value,
        registry: getAddress(row.registry.value),
        phase: row.phase.value as BackupRow['phase'],
        swarmRef: row.swarmRef.value,
        swarmNetwork: row.swarmNetwork.value,
        manifestHash: row.manifestHash.value,
        files: row.files.value,
        batchId: row.batchId.value,
      }));
  }

  /** Arkiv's latest block and its time in Unix seconds, to tell how long ago a row was written. */
  async function latestBlock(): Promise<{ number: bigint; time: number }> {
    const { currentBlock, currentBlockTime } = await client.getBlockTiming();
    return { number: currentBlock, time: currentBlockTime };
  }

  return { releaseRows, examRows, participantRows, backupRows, latestBlock };
}

export type ArkivReader = ReturnType<typeof createArkivReader>;
