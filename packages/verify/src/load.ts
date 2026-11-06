import { arkiv, type ArkivReader } from '@paperseal/arkiv';
import { decodeToken } from '@paperseal/attestation';
import { roundTimeSeconds, storageNames, type Hex } from '@paperseal/protocol';
import type { ReleaseLogResponse, StatusResponse, TeeClient } from '@paperseal/tee-client';

import { readChecked, withBackup, type BackupSource, type BackupUse, type Judged } from './backup';
import { checkFreshToken, checkPublishedToken, checkRecordToken, type Build, type FreshVerdict, type PublishedVerdict, type RecordVerdict } from './attest';
import type { ChainData } from './checks';
import { approvedEntries, checkManifest, holdersOf, type ManifestReport } from './commitments';
import type { ProofState } from './proof';
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
  /** Which files came from the Swarm backup, and which it could not give. Absent with backups off. */
  backup?: BackupUse;
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

/** A DER root in place of Google's, for tests only. */
const rootOf = (trustedRoot: Uint8Array | undefined) => (trustedRoot ? { trustedRoot } : {});

async function readToken(chain: ChainData, storage: StorageReader, examId: Hex, registry: Hex, bucket: string, trustedRoot?: Uint8Array) {
  const { exam, build } = chain;
  if (!exam) return neutral('The exam is not on the public record yet.');
  if (!build) return neutral('The paper is not recorded yet, so there is nothing to check the proof against.');
  const bytes = await storage.get(storageNames.token);
  if (!bytes) return neutral(`${storageNames.token} is not in storage yet. It is written before the Build.`);
  const token = utf8Text(bytes).trim();
  const verdict = await checkPublishedToken({ token, exam, build, examId, registry, bucket, ...rootOf(trustedRoot) });
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

const verifiedLog = (verdict: LogVerdict) =>
  verdict.examId === 'pass' && verdict.entriesHash === 'pass' && verdict.filesHash === 'pass' && verdict.signature === 'pass';

/** Why a backup copy of the release log did not pass, for the evidence. */
function logFailure(verdict: LogVerdict, token: RecordVerdict | null): string {
  if (verdict.examId !== 'pass') return `${storageNames.releaseLog} is for another exam.`;
  if (verdict.entriesHash !== 'pass') return `${storageNames.releaseLog} has an entriesHash that does not match its entries.`;
  if (!token?.verified) return `No ${releaseTokenName} attests the key that signed ${storageNames.releaseLog}.`;
  return `${storageNames.releaseLog} has a signature that does not check under the attested key.${verdict.error ? ` ${verdict.error}` : ''}`;
}

type LogCopy = { kind: 'malformed'; message: string } | { kind: 'read'; log: ReleaseLogResponse };

async function readLog(
  chain: ChainData,
  storage: StorageReader,
  examId: Hex,
  registry: Hex,
  bucket: string,
  trustedRoot?: Uint8Array,
): Promise<LogResult | Neutral> {
  const { exam, entries } = chain;
  // The token is checked against the key a log names. A backup copy counts only if it passes.
  const tokenFor = (log: ReleaseLogResponse, record: boolean): Promise<RecordVerdict | null> =>
    exam
      ? readChecked(
          storage,
          releaseTokenName,
          async (bytes) => {
            const token = await checkRecordToken({
              token: utf8Text(bytes).trim(),
              exam,
              examId,
              registry,
              instancePublicKey: log.instancePublicKey,
              bucket,
              ...rootOf(trustedRoot),
            });
            return { pass: token.verified, value: token, reason: `${releaseTokenName} does not attest the key that signed ${storageNames.releaseLog}.` };
          },
          { record },
        )
      : Promise.resolve(null);
  // A backup copy of the log counts only once it passes every check here, under a key a token attests.
  const copy = await readChecked(storage, storageNames.releaseLog, async (bytes): Promise<Judged<LogCopy>> => {
    let log: ReleaseLogResponse;
    try {
      log = parseReleaseLog(bytes);
    } catch (error) {
      const message = (error as Error).message;
      return { pass: false, value: { kind: 'malformed', message }, reason: message };
    }
    const token = await tokenFor(log, false);
    const verdict = await checkReleaseLog(log, examId, token?.verified ? log.instancePublicKey : null);
    return { pass: verifiedLog(verdict), value: { kind: 'read', log }, reason: logFailure(verdict, token) };
  });
  if (!copy) return neutral(`${storageNames.releaseLog} is not in storage yet. The TEE writes it at unlock.`);
  if (copy.kind === 'malformed') return copy;
  const { log } = copy;
  // Read again once the log is settled, so only the token copies tried against it are reported.
  const token = await tokenFor(log, true);
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
  /** The bucket the TEE must name: an exam name's, or the build-time default. */
  bucket: string;
  /** Where to find a Swarm backup of the files. Null or left out, the bucket is all there is. */
  backup?: BackupSource | null;
  /** A DER root in place of Google's. Tests only. */
  trustedRoot?: Uint8Array;
}): Promise<Records> {
  const { examId, registry, bucket, trustedRoot } = args;
  const chain = await args.chain();
  const off: Off = { kind: 'off' };
  // The backup is checked against this read's Build, so it is set up again for each read.
  const storage = args.storage ? withBackup(args.storage, args.backup ?? null, chain.build) : null;
  const [token, manifest, log] = await Promise.all([
    storage ? guarded(() => readToken(chain, storage, examId, registry, bucket, trustedRoot)) : off,
    storage ? guarded(() => readManifest(chain, storage, examId)) : off,
    storage ? guarded(() => readLog(chain, storage, examId, registry, bucket, trustedRoot)) : off,
  ]);
  return { chain, token, manifest, log, ...(storage && args.backup ? { backup: storage.use() } : {}) };
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
  bucket: string;
  /** A DER root in place of Google's. Tests and the mock suite only. */
  trustedRoot?: Uint8Array;
}): Promise<LiveReport | Neutral> {
  const { tee, examId, registry, bucket, trustedRoot } = args;
  const chain = args.chain();
  const exam = chain?.exam;
  if (!exam) return neutral('The exam is not on the public record yet.');
  const [fresh, status, log] = await Promise.all([
    attempt(() => checkFreshToken({ tee, exam, examId, registry, bucket, ...rootOf(trustedRoot) })),
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

/** How long the mirror may go without a heartbeat or log row before the page says it has stopped. */
export const ARKIV_STALE_AFTER_SECONDS = arkiv.staleAfterSeconds;

/** The verified release log from Arkiv with the most entries, and the row it came from. */
export interface ArkivLog {
  entityKey: Hex;
  creator: Hex;
  createdAtBlock: bigint;
  /** Unix seconds, worked out from Arkiv's latest block time and how many blocks ago the row was created. */
  writtenAt: number;
  entries: number;
  instancePublicKey: Hex;
  verdict: LogVerdict;
  progress: ReleaseProgress | null;
}

/** The newest heartbeat from the writers. Only a sign of life: it is never evidence and never counts. */
export interface ArkivHeartbeat {
  creator: Hex;
  createdAtBlock: bigint;
  /** Unix seconds, from Arkiv's own blocks, as for `ArkivLog.writtenAt`. */
  writtenAt: number;
  /** The TEE stage the writer says it last read, unchecked, or `''`. */
  stage: string;
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
  read: { logs: number; tokens: number; heartbeats: number };
  /** Null until a log passes every check. */
  log: ArkivLog | null;
  ignored: ArkivIgnored;
  /** The newest heartbeat, or null with none. */
  heartbeat: ArkivHeartbeat | null;
  /**
   * When the newest heartbeat or log row was written, in Unix seconds, or null with none. This is
   * the mirror's last sign of life (spec/arkiv.md, "Reading", rule 4).
   */
  newestAt: number | null;
  /**
   * How long ago that row was written, in seconds, from Arkiv's block distance alone: never the
   * device clock. Null with no heartbeat or log row at all.
   */
  ageSeconds: number | null;
}

/** The two reads `loadArkiv` makes. `createArkivReader` from `@paperseal/arkiv` gives both. */
export type ArkivSource = Pick<ArkivReader, 'releaseRows' | 'latestBlock'>;

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
  bucket: string;
  /** A DER root in place of Google's. Tests only. */
  trustedRoot?: Uint8Array;
}): Promise<ArkivReport | Neutral> {
  const { reader, examId, registry, writers, bucket } = args;
  const chain = args.chain();
  const exam = chain?.exam;
  if (!exam) return neutral('The exam is not on the public record yet.');
  const [{ logs, tokens, heartbeats }, latest] = await Promise.all([
    // Rule 1: only rows for this exam in the registry this view reads.
    reader.releaseRows(examId, writers, { registry }),
    reader.latestBlock(),
  ]);
  // A row's age is its distance from Arkiv's latest block. A row from a block past the latest one
  // the node reports is taken as just written.
  const blocksAgo = (block: bigint) => (latest.number > block ? Number(latest.number - block) : 0);
  const writtenAt = (block: bigint) => latest.time - blocksAgo(block) * ARKIV_BLOCK_SECONDS;
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
        bucket,
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

  // Heartbeats only say a writer is running. They never reach progress or any check.
  const newestBeat = heartbeats.reduce<(typeof heartbeats)[number] | null>(
    (max, row) => (max === null || row.createdAtBlock > max.createdAtBlock ? row : max),
    null,
  );
  // Rule 4: the mirror's last sign of life is its newest heartbeat or log row. Tokens are left out.
  const blocks = [...logs, ...heartbeats].map((row) => row.createdAtBlock);
  const newest = blocks.reduce<bigint | null>((max, block) => (max === null || block > max ? block : max), null);
  return {
    writers,
    read: { logs: logs.length, tokens: tokens.length, heartbeats: heartbeats.length },
    log: best,
    ignored,
    heartbeat: newestBeat
      ? {
          creator: newestBeat.creator,
          createdAtBlock: newestBeat.createdAtBlock,
          writtenAt: writtenAt(newestBeat.createdAtBlock),
          stage: newestBeat.stage,
        }
      : null,
    newestAt: newest === null ? null : writtenAt(newest),
    ageSeconds: newest === null ? null : blocksAgo(newest) * ARKIV_BLOCK_SECONDS,
  };
}

export type ProofRun =
  | {
      ok: true;
      result: ProofState;
      /** Which files the proof took from the Swarm backup. Absent with backups off. */
      backup?: BackupUse;
    }
  | { ok: false; message: string; backup?: BackupUse };

/** The end round decides, as drand reports it. This device's clock stands in until drand answers. */
export const roundReached = (round: number, latest: number | null, now: number) =>
  latest !== null ? latest >= round : now >= roundTimeSeconds(round);
