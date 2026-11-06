import { decodeToken } from '@paperseal/attestation';
import type { ChainClient } from '@paperseal/crypto';
import { roundTimeSeconds, storageNames, type Hex } from '@paperseal/protocol';
import type { StatusResponse, TeeClient } from '@paperseal/tee-client';
import { useEffect, useRef, useState } from 'react';

import { checkFreshToken, checkPublishedToken, checkRecordToken, type Build, type FreshVerdict, type PublishedVerdict, type RecordVerdict } from './attest';
import type { ChainData } from './checks';
import { approvedEntries, checkManifest, holdersOf, type ManifestReport } from './commitments';
import type { LatestRound } from './live';
import { runProof, type ProofState } from './proof';
import { releaseTokenName, utf8Text, type StorageReader } from './storage';
import {
  checkReleaseFiles,
  checkReleaseLog,
  parseReleaseLog,
  releaseProgress,
  type LogVerdict,
  type ReleaseFilesReport,
  type ReleaseProgress,
} from './unlock';

/** Nothing to judge yet. Never red, because nothing failed. */
export interface Neutral {
  kind: 'neutral';
  message: string;
}
/** The source is not configured. */
export interface Off {
  kind: 'off';
}
/** The source did not answer. That is not a check failing, and it is never a pass. */
export interface Unavailable {
  kind: 'unavailable';
  message: string;
}

export type Sourced<T> = T | Neutral | Off | Unavailable;

export type PublishedResult = { kind: 'ready'; verdict: PublishedVerdict; build: Build; issuedAt: number | null };
export type ManifestResult = { kind: 'ready'; report: ManifestReport; build: Build | null; owners: Record<string, string> };
export type LogResult =
  | { kind: 'malformed'; message: string }
  | {
      kind: 'ready';
      verdict: LogVerdict;
      /** The `release-token.jwt` check, or null if the token is not in storage. */
      token: RecordVerdict | null;
      progress: ReleaseProgress | null;
      /** The log's files against the list and storage. Null until the log's signature and token pass. */
      files: ReleaseFilesReport | null;
    };

/** One polled read of the public record: the chain, and each public file checked against it. */
export interface Records {
  chain: ChainData;
  token: Sourced<PublishedResult>;
  manifest: Sourced<ManifestResult>;
  log: Sourced<LogResult>;
}

const neutral = (message: string): Neutral => ({ kind: 'neutral', message });

/** One file that can't be read leaves the other checks standing. */
const guarded = async <T>(read: () => Promise<T | Neutral>): Promise<Sourced<T>> => {
  try {
    return await read();
  } catch (error) {
    return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
};

/** When the token says it was issued. For display only: nothing relies on it. */
function issuedAt(token: string): number | null {
  try {
    const { iat } = decodeToken(token);
    return typeof iat === 'number' ? iat : null;
  } catch {
    return null;
  }
}

async function readToken(chain: ChainData, storage: StorageReader, examId: Hex, registry: Hex) {
  const { exam, build } = chain;
  if (!exam) return neutral('The exam is not on the public record yet.');
  if (!build) return neutral('The paper is not recorded yet, so there is nothing to check the proof against.');
  const bytes = await storage.get(storageNames.token);
  if (!bytes) return neutral(`${storageNames.token} is not in storage yet. It is written before the Build.`);
  const token = utf8Text(bytes).trim();
  const verdict = await checkPublishedToken({ token, exam, build, examId, registry });
  return { kind: 'ready' as const, verdict, build, issuedAt: issuedAt(token) };
}

async function readManifest(chain: ChainData, storage: StorageReader, examId: Hex) {
  const { build, entries } = chain;
  const bytes = await storage.get(storageNames.manifest);
  if (!bytes) return neutral(`${storageNames.manifest} is not in storage yet. It is written before the Build.`);
  const list = approvedEntries(entries);
  return {
    kind: 'ready' as const,
    report: checkManifest(bytes, { examId, build, entries: list }),
    build,
    owners: Object.fromEntries((list ? holdersOf(list) : []).map((h) => [h.derivedPublicKey, h.owner])),
  };
}

async function readLog(chain: ChainData, storage: StorageReader, examId: Hex, registry: Hex): Promise<LogResult | Neutral> {
  const { exam, entries } = chain;
  const bytes = await storage.get(storageNames.releaseLog);
  if (!bytes) return neutral(`${storageNames.releaseLog} is not in storage yet. The TEE writes it at unlock.`);
  let log;
  try {
    log = parseReleaseLog(bytes);
  } catch (error) {
    return { kind: 'malformed', message: (error as Error).message };
  }
  const tokenBytes = await storage.get(releaseTokenName);
  const token =
    tokenBytes && exam
      ? await checkRecordToken({
          token: utf8Text(tokenBytes).trim(),
          exam,
          examId,
          registry,
          instancePublicKey: log.instancePublicKey,
        })
      : null;
  const list = approvedEntries(entries);
  // The log's own key is only used once `release-token.jwt` attests it. Until then there is no
  // key to check under, so the signature shows "Not checked" and never a pass.
  const verdict = await checkReleaseLog(log, examId, token?.verified ? log.instancePublicKey : null);
  return {
    kind: 'ready',
    verdict,
    token,
    progress: list
      ? releaseProgress(
          holdersOf(list),
          log.entries.map((entry) => entry.passkeyPublicKey),
        )
      : null,
    files: isValidLog(verdict, token) ? await checkReleaseFiles(log, list, storage) : null,
  };
}

/** Whether a log can be relied on for what it lists: its token, signature, exam and file list all passed. */
export const isValidLog = (verdict: LogVerdict, token: RecordVerdict | null) =>
  token?.verified === true && verdict.signature === 'pass' && verdict.examId === 'pass' && verdict.filesHash === 'pass';

/** The hash of `key-priv.tlock` in a valid log, for the proof. Null if there is none. */
export function signedKeyPriv(log: Records['log']): Hex | null {
  if (log.kind !== 'ready' || !log.files) return null;
  return log.files.files.find((file) => file.name === storageNames.keyPriv)?.sha256 ?? null;
}

export async function loadRecords(args: {
  chain: () => Promise<ChainData>;
  storage: StorageReader | null;
  examId: Hex;
  registry: Hex;
}): Promise<Records> {
  const { storage, examId, registry } = args;
  const chain = await args.chain();
  const off: Off = { kind: 'off' };
  const [token, manifest, log] = await Promise.all([
    storage ? guarded(() => readToken(chain, storage, examId, registry)) : off,
    storage ? guarded(() => readManifest(chain, storage, examId)) : off,
    storage ? guarded(() => readLog(chain, storage, examId, registry)) : off,
  ]);
  return { chain, token, manifest, log };
}

export type LiveRead<T> = { ok: true; value: T } | { ok: false; message: string };

const attempt = async <T>(read: () => Promise<T>): Promise<LiveRead<T>> => {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

/** What the optional live TEE says. Until `fresh` is trusted, all of it is hearsay. */
export interface LiveReport {
  fresh: LiveRead<FreshVerdict>;
  status: LiveRead<StatusResponse>;
  progress: ReleaseProgress | null;
  log: LogVerdict | null;
}

export async function loadLive(args: {
  tee: TeeClient;
  chain: () => ChainData | null;
  examId: Hex;
  registry: Hex;
}): Promise<LiveReport | Neutral> {
  const { tee, examId, registry } = args;
  const chain = args.chain();
  const exam = chain?.exam;
  if (!exam) return neutral('The exam is not on the public record yet.');
  const [fresh, status, log] = await Promise.all([
    attempt(() => checkFreshToken({ tee, exam, examId, registry })),
    attempt(() => tee.status()),
    tee.releaseLog().catch(() => null),
  ]);
  const list = approvedEntries(chain.entries);
  const trusted = fresh.ok && fresh.value.trusted ? fresh.value.instancePublicKey : null;
  return {
    fresh,
    status,
    progress: list && status.ok ? releaseProgress(holdersOf(list), status.value.release.released) : null,
    // Only a log signed by the key that just passed attestation is checked under that key.
    log: log ? await checkReleaseLog(log, examId, trusted && log.instancePublicKey === trusted ? trusted : null) : null,
  };
}

export type ProofRun = { ok: true; result: ProofState } | { ok: false; message: string };

/** The end round decides, as drand reports it. This device's clock stands in until drand answers. */
export const roundReached = (round: number, latest: number | null, now: number) =>
  latest !== null ? latest >= round : now >= roundTimeSeconds(round);

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
}): ProofRun | null {
  const { storage, examId, client, chain, keyPrivSha256, latest, now, retryMs = PROOF_RETRY_MS } = args;
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
    runProof({
      storage,
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
        if (live) setRun({ key, storage, value: { ok: true, result } });
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (live) setRun({ key, storage, value: { ok: false, message } });
      },
    );
    return () => {
      live = false;
    };
  }, [key, reached, attempts, storage, examId, client]);

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
