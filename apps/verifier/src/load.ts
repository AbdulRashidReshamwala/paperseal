import type { ChainClient } from '@paperseal/crypto';
import type { Hex } from '@paperseal/protocol';
import {
  loadArkiv as verifyArkiv,
  loadLive as verifyLive,
  loadRecords as verifyRecords,
  roundReached,
  runProof,
  withBackup,
  type BackupSource,
  type ChainData,
  type ProofRun,
  type StorageReader,
} from '@paperseal/verify';
import { useEffect, useRef, useState } from 'react';

import type { LatestRound } from './live';
import { rootOption } from './mockMode';

export {
  ARKIV_BLOCK_SECONDS,
  ARKIV_STALE_AFTER_SECONDS,
  isValidLog,
  roundReached,
  signedKeyPriv,
  type ArkivHeartbeat,
  type ArkivIgnored,
  type ArkivLog,
  type ArkivReport,
  type ArkivSource,
  type LiveRead,
  type LiveReport,
  type LogResult,
  type ManifestResult,
  type Neutral,
  type Off,
  type ProofRun,
  type PublishedResult,
  type Records,
  type Sourced,
  type Unavailable,
} from '@paperseal/verify';

/*
 * The loaders from `@paperseal/verify`, with the mock suite's attestation root when this page runs
 * in that mode (src/mockMode.ts). Outside it they are the package's loaders as they are.
 */
export const loadRecords = (args: Parameters<typeof verifyRecords>[0]) => verifyRecords({ ...rootOption(), ...args });
export const loadLive = (args: Parameters<typeof verifyLive>[0]) => verifyLive({ ...rootOption(), ...args });
export const loadArkiv = (args: Parameters<typeof verifyArkiv>[0]) => verifyArkiv({ ...rootOption(), ...args });

/** How long to wait before trying again a proof that did not open the paper. */
export const PROOF_RETRY_MS = 60_000;

/**
 * Waits for the end round, then runs the proof. Polling must not restart it: a run starts when the
 * round is reached or the Build first appears, and is only retried while the paper has not opened.
 */
export function useProof(args: {
  storage: StorageReader | null;
  examId: Hex | null;
  client: ChainClient;
  chain: ChainData | null;
  /** See `ProofInput`. Read at each run, so a retry sees a log that appeared since the last one. */
  keyPrivSha256: Hex | null;
  latest: LatestRound;
  now: number;
  retryMs?: number;
  /** Where to find a Swarm backup of the files, or null with backups off. */
  backup?: BackupSource | null;
}): ProofRun | null {
  const { storage, examId, client, chain, keyPrivSha256, latest, now, retryMs = PROOF_RETRY_MS, backup = null } = args;
  const endRound = chain?.exam ? Number(chain.exam.settings.endRound) : null;
  const reached = endRound !== null && roundReached(endRound, latest.round, now);
  const key = `${String(reached)}|${String(latest.round !== null)}|${String(chain?.build?.postedAt)}`;
  const [run, setRun] = useState<{ key: string; storage: StorageReader | null; value: ProofRun } | null>(null);
  const [attempts, setAttempts] = useState(0);

  // The round and the clock only decide when to start. Later ticks must not restart it.
  const inputs = useRef({ chain, keyPrivSha256, currentRound: latest.round });
  useEffect(() => {
    inputs.current = { chain, keyPrivSha256, currentRound: latest.round };
  }, [chain, keyPrivSha256, latest.round]);

  useEffect(() => {
    if (!reached) return;
    let live = true;
    const { chain: data, keyPrivSha256: signed, currentRound } = inputs.current;
    const backed = storage ? withBackup(storage, backup, data?.build ?? null) : null;
    const used = () => (backed && backup ? { backup: backed.use() } : {});
    runProof({
      storage: backed,
      examId,
      exam: data?.exam ?? null,
      build: data?.build ?? null,
      criteria: data?.criteria ?? null,
      currentRound,
      keyPrivSha256: signed,
      now: Math.floor(Date.now() / 1000),
      client,
    }).then(
      (result) => {
        if (live) setRun({ key, storage, value: { ok: true, result, ...used() } });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (live) setRun({ key, storage, value: { ok: false, message, ...used() } });
      },
    );
    return () => {
      live = false;
    };
  }, [key, reached, attempts, storage, examId, client, backup]);

  const current = run?.key === key && run.storage === storage ? run.value : null;
  const opened = current?.ok === true && current.result.state === 'opened';

  useEffect(() => {
    if (!current || opened) return;
    const timer = setTimeout(() => {
      setAttempts((count) => count + 1);
    }, retryMs);
    return () => {
      clearTimeout(timer);
    };
  }, [current, opened, retryMs]);

  return current;
}
