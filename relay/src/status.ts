import type { ArkivReader } from '@paperseal/arkiv';
import type { Address, Hex } from 'viem';

/*
 * `status`: this exam's rows on Arkiv from one writer, newest first. Read-only. It shows what the
 * rows hold; it doesn't verify them (the verifier does, as in spec/arkiv.md "Reading").
 */

/** Rabdi blocks are 2 seconds apart (packages/arkiv reader.ts). */
const blockSeconds = 2;

export interface StatusRow {
  kind: 'log' | 'token';
  entityKey: Hex;
  createdAtBlock: bigint;
  /** Unix seconds, estimated from the latest block. */
  writtenAt: number | undefined;
  registry: Address;
  /** For a log: `entriesHash` and the number of entries in its body. For a token: `instanceKeyHash`. */
  detail: string;
}

function entriesIn(body: Uint8Array): string {
  try {
    const log = JSON.parse(new TextDecoder().decode(body)) as { entries?: unknown };
    return Array.isArray(log.entries) ? `${String(log.entries.length)} entries` : 'body has no entries';
  } catch {
    return 'body is not JSON';
  }
}

export async function statusRows(
  reader: Pick<ArkivReader, 'releaseRows' | 'latestBlock'>,
  examId: Hex,
  writer: Address,
): Promise<{ rows: StatusRow[]; latest: { number: bigint; time: number } | undefined }> {
  const [{ logs, tokens }, latest] = await Promise.all([
    reader.releaseRows(examId, [writer]),
    reader.latestBlock().catch(() => undefined),
  ]);
  const at = (block: bigint) =>
    latest ? latest.time - Number(latest.number - block) * blockSeconds : undefined;
  const rows: StatusRow[] = [
    ...logs.map((row) => ({
      kind: 'log' as const,
      entityKey: row.entityKey,
      createdAtBlock: row.createdAtBlock,
      writtenAt: at(row.createdAtBlock),
      registry: row.registry,
      detail: `entriesHash ${row.entriesHash}, ${entriesIn(row.body)}`,
    })),
    ...tokens.map((row) => ({
      kind: 'token' as const,
      entityKey: row.entityKey,
      createdAtBlock: row.createdAtBlock,
      writtenAt: at(row.createdAtBlock),
      registry: row.registry,
      detail: `instanceKeyHash ${row.instanceKeyHash}`,
    })),
  ];
  rows.sort((a, b) =>
    a.createdAtBlock === b.createdAtBlock
      ? a.entityKey.localeCompare(b.entityKey)
      : a.createdAtBlock > b.createdAtBlock
        ? -1
        : 1,
  );
  return { rows, latest };
}
