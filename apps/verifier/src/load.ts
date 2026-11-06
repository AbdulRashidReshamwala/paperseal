import { arkiv, type ArkivReader } from '@paperseal/arkiv';
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
import { checkReleaseLog, parseReleaseLog, releaseProgress, type LogVerdict, type ReleaseProgress } from './unlock';

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
    };

/** One polled read of the public record: the chain, and each public file checked against it. */
export interface Records {
  chain: ChainData;
  token: Sourced<PublishedResult>;
  manifest: Sourced<ManifestResult>;
  log: Sourced<LogResult>;
}

const neutral = (message: string): Neutral => ({ kind: 'neutral', message });

/** Left out, the checks use the build-time `teeStorageBucket`. */
const bucketOf = (bucket: string | undefined) => (bucket === undefined ? {} : { bucket });

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

async function readToken(chain: ChainData, storage: StorageReader, examId: Hex, registry: Hex, bucket?: string) {
  const { exam, build } = chain;
  if (!exam) return neutral('The exam is not on the public record yet.');
  if (!build) return neutral('The paper is not recorded yet, so there is nothing to check the proof against.');
  const bytes = await storage.get(storageNames.token);
  if (!bytes) return neutral(`${storageNames.token} is not in storage yet. It is written before the Build.`);
  const token = utf8Text(bytes).trim();
  const verdict = await checkPublishedToken({ token, exam, build, examId, registry, ...bucketOf(bucket) });
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

async function readLog(chain: ChainData, storage: StorageReader, examId: Hex, registry: Hex, bucket?: string): Promise<LogResult | Neutral> {
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
          ...bucketOf(bucket),
        })
      : null;
  const list = approvedEntries(entries);
  return {
    kind: 'ready',
    // The log's own key is only used once `release-token.jwt` attests it. Until then there is no
    // key to check under, so the signature shows "Not checked" and never a pass.
    verdict: await checkReleaseLog(log, examId, token?.verified ? log.instancePublicKey : null),
    token,
    progress: list
      ? releaseProgress(
          holdersOf(list),
          log.entries.map((entry) => entry.passkeyPublicKey),
        )
      : null,
  };
}

export async function loadRecords(args: {
  chain: () => Promise<ChainData>;
  storage: StorageReader | null;
  examId: Hex;
  registry: Hex;
  /** The bucket the TEE must name, from an exam name. `teeStorageBucket` when left out. */
  bucket?: string;
}): Promise<Records> {
  const { storage, examId, registry, bucket } = args;
  const chain = await args.chain();
  const off: Off = { kind: 'off' };
  const [token, manifest, log] = await Promise.all([
    storage ? guarded(() => readToken(chain, storage, examId, registry, bucket)) : off,
    storage ? guarded(() => readManifest(chain, storage, examId)) : off,
    storage ? guarded(() => readLog(chain, storage, examId, registry, bucket)) : off,
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
  bucket?: string;
}): Promise<LiveReport | Neutral> {
  const { tee, examId, registry, bucket } = args;
  const chain = args.chain();
  const exam = chain?.exam;
  if (!exam) return neutral('The exam is not on the public record yet.');
  const [fresh, status, log] = await Promise.all([
    attempt(() => checkFreshToken({ tee, exam, examId, registry, ...bucketOf(bucket) })),
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

/** Rabdi makes a block every 2 seconds, so a row's age is its distance from the latest block. */
export const ARKIV_BLOCK_SECONDS = 2;

/** How long the mirror may go without a new row before the page says it has stopped. */
export const ARKIV_STALE_AFTER_SECONDS = arkiv.staleAfterSeconds;

/** The verified release log from Arkiv with the most entries, and the row it came from. */
export interface ArkivLog {
  entityKey: Hex;
  creator: Hex;
  createdAtBlock: bigint;
  /** Unix seconds, worked out from how many blocks ago the row was created. */
  writtenAt: number;
  entries: number;
  instancePublicKey: Hex;
  verdict: LogVerdict;
  progress: ReleaseProgress | null;
}

/** Rows from published writers that did not count, by why. Never a failure of the exam. */
export interface ArkivIgnored {
  /** Tokens that attest none of the keys the logs name. */
  tokens: number;
  /** Logs whose body is not a release log. */
  unreadable: number;
  /** Logs signed by a key no passing token attests. */
  unattested: number;
  /** Logs signed by an attested key that still fail their check. */
  failed: number;
}

export interface ArkivReport {
  writers: readonly Hex[];
  read: { logs: number; tokens: number };
  /** Null until a log passes every check. */
  log: ArkivLog | null;
  ignored: ArkivIgnored;
  /** When the newest row from these writers was written, in Unix seconds, or null with none. */
  newestAt: number | null;
}

/** The two reads `loadArkiv` makes. `createArkivReader` from `@paperseal/arkiv` gives both. */
export type ArkivSource = Pick<ArkivReader, 'releaseRows' | 'latestBlock'>;

const verifiedLog = (verdict: LogVerdict) =>
  verdict.examId === 'pass' && verdict.entriesHash === 'pass' && verdict.signature === 'pass';

/**
 * Reads the Arkiv mirror as spec/arkiv.md "Reading" says. A token row counts only once it passes
 * the same check as `release-token.jwt` in storage, and a log row only once it passes under a key
 * such a token attests. Everything else is counted as ignored and shown nowhere. A failed read
 * throws, so the page says the mirror could not be read and nothing more.
 */
export async function loadArkiv(args: {
  reader: ArkivSource;
  chain: () => ChainData | null;
  examId: Hex;
  registry: Hex;
  writers: readonly Hex[];
  bucket?: string;
  /** A DER root in place of Google's. Tests only. */
  trustedRoot?: Uint8Array;
}): Promise<ArkivReport | Neutral> {
  const { reader, examId, registry, writers, bucket } = args;
  const chain = args.chain();
  const exam = chain?.exam;
  if (!exam) return neutral('The exam is not on the public record yet.');
  const [{ logs, tokens }, latest] = await Promise.all([reader.releaseRows(examId, writers), reader.latestBlock()]);
  const writtenAt = (block: bigint) => latest.time - Number(latest.number - block) * ARKIV_BLOCK_SECONDS;
  const ignored: ArkivIgnored = { tokens: 0, unreadable: 0, unattested: 0, failed: 0 };

  const parsed = logs.map((row) => {
    try {
      return { row, log: parseReleaseLog(row.body) };
    } catch {
      return { row, log: null };
    }
  });
  // A token binds its instance key only through a hash, so it is checked against each key a log names.
  const keys = [...new Set(parsed.flatMap(({ log }) => (log ? [log.instancePublicKey] : [])))];
  const attested = new Set<Hex>();
  for (const row of tokens) {
    const token = utf8Text(row.body).trim();
    let passed = false;
    for (const instancePublicKey of keys) {
      const verdict = await checkRecordToken({
        token,
        exam,
        examId,
        registry,
        instancePublicKey,
        ...bucketOf(bucket),
        ...(args.trustedRoot ? { trustedRoot: args.trustedRoot } : {}),
      }).catch(() => null);
      if (verdict?.verified) {
        attested.add(instancePublicKey);
        passed = true;
        break;
      }
    }
    // With no log to pair it with, a token has nothing to attest yet, and is not counted against.
    if (!passed && keys.length > 0) ignored.tokens += 1;
  }

  const list = approvedEntries(chain.entries);
  let best: ArkivLog | null = null;
  for (const { row, log } of parsed) {
    if (!log) {
      ignored.unreadable += 1;
      continue;
    }
    if (!attested.has(log.instancePublicKey)) {
      ignored.unattested += 1;
      continue;
    }
    const verdict = await checkReleaseLog(log, examId, log.instancePublicKey);
    if (!verifiedLog(verdict)) {
      ignored.failed += 1;
      continue;
    }
    // Logs only grow, so a verified log with fewer entries is an earlier snapshot.
    const larger = !best || log.entries.length > best.entries || (log.entries.length === best.entries && row.createdAtBlock > best.createdAtBlock);
    if (larger) {
      best = {
        entityKey: row.entityKey,
        creator: row.creator,
        createdAtBlock: row.createdAtBlock,
        writtenAt: writtenAt(row.createdAtBlock),
        entries: log.entries.length,
        instancePublicKey: log.instancePublicKey,
        verdict,
        progress: list
          ? releaseProgress(
              holdersOf(list),
              log.entries.map((entry) => entry.passkeyPublicKey),
            )
          : null,
      };
    }
  }

  const blocks = [...logs, ...tokens].map((row) => row.createdAtBlock);
  const newest = blocks.reduce<bigint | null>((max, block) => (max === null || block > max ? block : max), null);
  return {
    writers,
    read: { logs: logs.length, tokens: tokens.length },
    log: best,
    ignored,
    newestAt: newest === null ? null : writtenAt(newest),
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
  latest: LatestRound;
  now: number;
  retryMs?: number;
}): ProofRun | null {
  const { storage, examId, client, chain, latest, now, retryMs = PROOF_RETRY_MS } = args;
  const endRound = chain?.exam ? Number(chain.exam.settings.endRound) : null;
  const reached = endRound !== null && roundReached(endRound, latest.round, now);
  const key = `${String(reached)}|${String(latest.round !== null)}|${String(chain?.build?.postedAt)}`;
  const [run, setRun] = useState<{ key: string; storage: StorageReader | null; value: ProofRun } | null>(null);
  const [attempts, setAttempts] = useState(0);

  // The round and the clock only decide when to start. Later ticks must not restart it.
  const inputs = useRef({ chain, currentRound: latest.round });
  useEffect(() => {
    inputs.current = { chain, currentRound: latest.round };
  }, [chain, latest.round]);

  useEffect(() => {
    if (!reached) return;
    let live = true;
    const { chain: data, currentRound } = inputs.current;
    runProof({
      storage,
      examId,
      exam: data?.exam ?? null,
      build: data?.build ?? null,
      criteria: data?.criteria ?? null,
      currentRound,
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
