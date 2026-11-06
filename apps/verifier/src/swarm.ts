import type { ArkivReader } from '@paperseal/arkiv';
import type { Hex } from '@paperseal/protocol';
import type { SwarmClient } from '@paperseal/swarm';
import type { BackupCache, ChainData, StorageReader } from '@paperseal/verify';

import { teeStorageBucket } from './env';
import { ARKIV_BLOCK_SECONDS, isValidLog, loadRecords, type LogResult, type ManifestResult, type PublishedResult, type Sourced } from './load';

/*
 * Each Swarm backup recorded for an exam, read in full. A backup is opened as if it were the bucket and
 * goes through the same `loadRecords` checks as the bucket's own copies, against this read of the
 * chain, so what is shown here is what passed and nothing else. The result only fills in the Copies
 * section. It never reaches a step, so a copy can't turn a check green, and one that fails is not a
 * failure of the exam (spec/arkiv.md, "Backups", "Reading").
 */

export type BackupRow = Awaited<ReturnType<ArkivReader['backupRows']>>[number];

/** The Arkiv reads this needs. `createArkivReader` from `@paperseal/arkiv` gives both. */
export type SwarmRowSource = Pick<ArkivReader, 'backupRows' | 'latestBlock'>;

export interface SwarmCopy {
  row: BackupRow;
  /** Unix seconds, from Arkiv's own blocks, as for `ArkivLog.writtenAt`. */
  writtenAt: number;
  /** `<Swarm API>/bzz/<reference>/manifest.json`, to open it. */
  url: string;
  /** What the checks made of this collection's copies. Absent when no Swarm API is set. */
  read?: { token: Sourced<PublishedResult>; manifest: Sourced<ManifestResult>; log: Sourced<LogResult> };
}

export interface SwarmReport {
  /** Newest `unlock` first, as `backupRows` gives them. Empty means no backup is recorded for this exam. */
  copies: SwarmCopy[];
  /** The Swarm API read, or null with none set. */
  apiUrl: string | null;
}

/** One collection as a bucket. Content under a reference never changes, so bytes are kept for the visit. */
function collection(swarm: Pick<SwarmClient, 'download'>, reference: string, api: string, cache: BackupCache): StorageReader {
  return {
    url: (name) => `${api}/bzz/${reference}/${name}`,
    get: (name) => {
      const key = `${reference}/${name}`;
      const known = cache.files.get(key);
      if (known) return known;
      const read = swarm.download(reference, name);
      cache.files.set(key, read);
      read.then(
        (bytes) => {
          if (bytes === null) cache.files.delete(key);
        },
        () => cache.files.delete(key),
      );
      return read;
    },
  };
}

export async function loadSwarm(args: {
  rows: SwarmRowSource;
  swarm: Pick<SwarmClient, 'download'> | null;
  apiUrl: string;
  cache: BackupCache;
  chain: () => ChainData | null;
  writers: readonly Hex[];
  examId: Hex;
  registry: Hex;
  /** The bucket the TEE must name. Left out, the build-time default. */
  bucket?: string;
  /** A DER root in place of Google's. Tests only. */
  trustedRoot?: Uint8Array;
}): Promise<SwarmReport> {
  const { rows, swarm, cache, writers, examId, registry, bucket = teeStorageBucket, trustedRoot } = args;
  const api = args.apiUrl.replace(/\/+$/, '');
  const [found, latest] = await Promise.all([rows.backupRows(examId, writers, { registry }), rows.latestBlock()]);
  const chain = args.chain();
  const blocksAgo = (block: bigint) => (latest.number > block ? Number(latest.number - block) : 0);
  const copies = await Promise.all(
    found.map(async (row): Promise<SwarmCopy> => {
      const base = { row, writtenAt: latest.time - blocksAgo(row.createdAtBlock) * ARKIV_BLOCK_SECONDS, url: `${api}/bzz/${row.swarmRef}/manifest.json` };
      if (!swarm || !chain) return base;
      const { token, manifest, log } = await loadRecords({
        chain: () => Promise.resolve(chain),
        storage: collection(swarm, row.swarmRef, api, cache),
        examId,
        registry,
        bucket,
        ...(trustedRoot ? { trustedRoot } : {}),
      });
      return { ...base, read: { token, manifest, log } };
    }),
  );
  return { copies, apiUrl: swarm ? api : null };
}

/** Whether this copy's release log passed every check. */
export const swarmLogPassed = (copy: SwarmCopy): boolean => {
  const log = copy.read?.log;
  return log?.kind === 'ready' && isValidLog(log.verdict, log.token);
};
