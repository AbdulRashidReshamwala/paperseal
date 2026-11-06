import type { ArkivReader } from '@paperseal/arkiv';
import type { Address, Hex } from 'viem';

/*
 * `status`: this exam's rows on Arkiv from one writer, newest first, with its heartbeats apart.
 * Read-only. It shows what the rows hold; it doesn't verify them (the verifier does, as in
 * spec/arkiv.md "Reading"). A heartbeat isn't evidence: what it says is the writer's word.
 */

/** Rabdi blocks are 2 seconds apart (packages/arkiv reader.ts). */
const blockSeconds = 2;

export interface StatusRow {
  kind: 'log' | 'token' | 'heartbeat';
  entityKey: Hex;
  createdAtBlock: bigint;
  /** Unix seconds, estimated from the latest block. */
  writtenAt: number | undefined;
  /** Seconds between this row's block and the latest block, as readers time heartbeats. */
  ageSeconds: number | undefined;
  registry: Address;
  /**
   * For a log: `entriesHash` and the number of entries in its body. For a token: `instanceKeyHash`.
   * For a heartbeat: the `entriesHash` and TEE stage it says the writer last saw.
   */
  detail: string;
}

export interface Status {
  rows: StatusRow[];
  heartbeats: StatusRow[];
  latest: { number: bigint; time: number } | undefined;
}

function entriesIn(body: Uint8Array): string {
  try {
    const log = JSON.parse(new TextDecoder().decode(body)) as { entries?: unknown };
    return Array.isArray(log.entries) ? `${String(log.entries.length)} entries` : 'body has no entries';
  } catch {
    return 'body is not JSON';
  }
}

const newestFirst = (a: StatusRow, b: StatusRow) =>
  a.createdAtBlock === b.createdAtBlock
    ? a.entityKey.localeCompare(b.entityKey)
    : a.createdAtBlock > b.createdAtBlock
      ? -1
      : 1;

/** `registry` undefined reads the exam's rows for every registry; `status --registry` narrows it. */
export async function statusRows(
  reader: Pick<ArkivReader, 'releaseRows' | 'latestBlock'>,
  examId: Hex,
  writer: Address,
  registry?: Address,
): Promise<Status> {
  const [{ logs, tokens, heartbeats }, latest] = await Promise.all([
    reader.releaseRows(examId, [writer], { registry }),
    reader.latestBlock().catch(() => undefined),
  ]);
  const timing = (block: bigint) => {
    if (!latest) return { writtenAt: undefined, ageSeconds: undefined };
    const ageSeconds = Number(latest.number - block) * blockSeconds;
    return { writtenAt: latest.time - ageSeconds, ageSeconds };
  };
  const rows: StatusRow[] = [
    ...logs.map((row) => ({
      kind: 'log' as const,
      entityKey: row.entityKey,
      createdAtBlock: row.createdAtBlock,
      ...timing(row.createdAtBlock),
      registry: row.registry,
      detail: `entriesHash ${row.entriesHash}, ${entriesIn(row.body)}`,
    })),
    ...tokens.map((row) => ({
      kind: 'token' as const,
      entityKey: row.entityKey,
      createdAtBlock: row.createdAtBlock,
      ...timing(row.createdAtBlock),
      registry: row.registry,
      detail: `instanceKeyHash ${row.instanceKeyHash}`,
    })),
  ];
  const beats: StatusRow[] = heartbeats.map((row) => ({
    kind: 'heartbeat' as const,
    entityKey: row.entityKey,
    createdAtBlock: row.createdAtBlock,
    ...timing(row.createdAtBlock),
    registry: row.registry,
    detail: `entriesHash ${row.entriesHash || 'none'}, TEE stage ${row.stage || 'none'}`,
  }));
  rows.sort(newestFirst);
  beats.sort(newestFirst);
  return { rows, heartbeats: beats, latest };
}

/** "42s ago", "3m 5s ago", "2h 1m ago"; "age unknown" without the latest block. */
export function ageText(seconds: number | undefined): string {
  if (seconds === undefined) return 'age unknown';
  const s = Math.max(0, seconds);
  if (s < 60) return `${String(s)}s ago`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m ${String(s % 60)}s ago`;
  return `${String(Math.floor(s / 3600))}h ${String(Math.floor((s % 3600) / 60))}m ago`;
}
