import { instanceKeyHash, MirrorInputError, type ArkivWriter, type MirrorResult } from '@paperseal/arkiv';
import type { Stage } from '@paperseal/protocol';
import type { Address, Hash, Hex } from 'viem';

import type { MirrorTarget } from './args';
import { errorText } from './output';
import { fetchStorageFile, releaseFiles, type Fetch } from './storage';
import { describeTeeError, readTee, readTeeAttestation } from './tee';

/*
 * One mirror pass, as in spec/arkiv.md "Writers". It reads storage and/or the TEE, then creates a
 * row for each new token and log through @paperseal/arkiv, which skips any this writer already
 * has. Tokens go first: a log is only written once a token attesting its signer is on Arkiv,
 * because a reader ignores a log whose signer no token attests. Nothing here checks a signature:
 * the relay only copies evidence, and readers check every body.
 *
 * What may be mirrored is exactly the release log and the Unlock instance's PKI token. This file
 * reads nothing else, so it can't mirror anything else.
 */

export type Source = 'storage' | 'tee';
export type Kind = 'token' | 'log';

export interface Outcome {
  kind: Kind;
  source: Source;
  /**
   * `written`: a new row. `skipped`: this writer already has it. `held`: not written yet, and a
   * later pass may write it. `refused`: this evidence is not for this exam, or isn't evidence.
   * `failed`: the write was tried and failed.
   */
  result: 'written' | 'skipped' | 'held' | 'refused' | 'failed';
  detail: string;
  /** The `instanceKeyHash` of a token, or the `entriesHash` of a log. */
  key?: string;
  entityKey?: Hex;
  txHash?: Hash;
}

export interface PassReport {
  at: Date;
  outcomes: Outcome[];
  /** What a source didn't have, or couldn't give. Never fatal. */
  notes: string[];
  /** The release logs for this exam this pass read, written or not. `watch` puts the newest in its heartbeat. */
  logs: { source: Source; entriesHash: string; entries: number }[];
  tee: {
    stage?: Stage;
    /** True if the TEE showed this exam, false if it showed another, undefined if it showed neither. */
    servesExam?: boolean;
  };
}

/** What a pass needs from the writer. `createArkivWriter`'s result has it. */
export type RelayWriter = Pick<ArkivWriter, 'address' | 'mirrorReleaseLog' | 'mirrorReleaseToken'>;

export interface PassDeps {
  fetch: Fetch;
  writer: RelayWriter;
  /** `chain.chainId` in spec/constants.json: the chain `registry` is on. */
  chainId: number;
}

/**
 * Rows this relay has already confirmed on Arkiv in this run, so `watch` doesn't ask Arkiv again
 * every few seconds. `tokens` is keyed by `instanceKeyHash`, `logs` by `entriesHash`.
 */
export interface Memo {
  tokens: Map<string, Hex>;
  logs: Map<string, Hex>;
}

export const newMemo = (): Memo => ({ tokens: new Map(), logs: new Map() });

interface LogCandidate {
  source: Source;
  body: Uint8Array;
  entriesHash: string;
  entries: number;
  instancePublicKey: Hex;
  keyHash: string;
}

interface TokenCandidate {
  source: Source;
  body: Uint8Array;
  instancePublicKey: Hex;
  keyHash: string;
}

const hash32 = /^0x[0-9a-fA-F]{64}$/;
const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

/** Just enough of a release log to place it. Returns a reason when it can't be mirrored for this exam. */
export function readReleaseLog(body: Uint8Array, examId: Hex): Omit<LogCandidate, 'source'> | { refused: string } {
  let log: unknown;
  try {
    log = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return { refused: 'the release log is not UTF-8 JSON' };
  }
  if (typeof log !== 'object' || log === null || Array.isArray(log)) return { refused: 'the release log is not a JSON object' };
  const fields = log as Record<string, unknown>;
  if (typeof fields.examId !== 'string' || fields.examId.toLowerCase() !== examId.toLowerCase()) {
    return { refused: `the release log is for exam ${String(fields.examId)}, not ${examId}` };
  }
  if (typeof fields.entriesHash !== 'string' || !hash32.test(fields.entriesHash)) {
    return { refused: 'the release log entriesHash is not 32 bytes of hex' };
  }
  if (!Array.isArray(fields.entries)) return { refused: 'the release log entries is not an array' };
  if (typeof fields.instancePublicKey !== 'string') return { refused: 'the release log has no instancePublicKey' };
  const instancePublicKey = fields.instancePublicKey.toLowerCase() as Hex;
  let keyHash: string;
  try {
    keyHash = instanceKeyHash(instancePublicKey);
  } catch (error) {
    return { refused: `the release log instancePublicKey: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { body, entriesHash: fields.entriesHash.toLowerCase(), entries: fields.entries.length, instancePublicKey, keyHash };
}

interface Gathered {
  logs: LogCandidate[];
  tokens: TokenCandidate[];
  outcomes: Outcome[];
  notes: string[];
  tee: PassReport['tee'];
}

async function gatherStorage(target: MirrorTarget, send: Fetch, into: Gathered): Promise<void> {
  const base = target.storageUrl;
  if (!base) return;
  const get = async (name: string): Promise<Uint8Array | null | undefined> => {
    try {
      const bytes = await fetchStorageFile(send, base, target.examId, name);
      if (bytes === null) into.notes.push(`storage: no ${name} yet`);
      return bytes;
    } catch (error) {
      into.notes.push(`storage: could not read ${name}: ${errorText(error)}`);
      return undefined;
    }
  };
  const [logBytes, tokenBytes] = await Promise.all([get(releaseFiles.log), get(releaseFiles.token)]);

  let log: Omit<LogCandidate, 'source'> | undefined;
  if (logBytes) {
    const read = readReleaseLog(logBytes, target.examId);
    if ('refused' in read) into.outcomes.push({ kind: 'log', source: 'storage', result: 'refused', detail: read.refused });
    else {
      log = read;
      into.logs.push({ ...read, source: 'storage' });
    }
  }
  if (tokenBytes) {
    // spec/api.md "Storage": release-token.jwt attests the key that signed release-log.json.
    if (log) into.tokens.push({ source: 'storage', body: tokenBytes, instancePublicKey: log.instancePublicKey, keyHash: log.keyHash });
    else if (logBytes) into.outcomes.push({ kind: 'token', source: 'storage', result: 'refused', detail: `${releaseFiles.log} beside it can't be used, so its instance key is unknown` });
    else into.outcomes.push({ kind: 'token', source: 'storage', result: 'held', detail: `no usable ${releaseFiles.log} beside it names its instance key` });
  }
}

async function gatherTee(target: MirrorTarget, send: Fetch, into: Gathered): Promise<void> {
  const base = target.teeUrl;
  if (!base) return;
  const snapshot = await readTee(send, base);
  if (snapshot.status) {
    into.tee.stage = snapshot.status.stage;
    const listed = snapshot.status.approvedList?.examId;
    if (listed !== undefined) into.tee.servesExam = listed.toLowerCase() === target.examId;
  } else {
    into.notes.push(`tee: could not read /v1/status: ${snapshot.statusError ?? 'no answer'}`);
  }
  if (into.tee.servesExam === false) {
    into.notes.push(`tee: it serves exam ${String(snapshot.status?.approvedList?.examId)}, not this one, so its evidence is ignored`);
    return;
  }
  if (!snapshot.log) {
    into.notes.push(
      snapshot.logNotYet
        ? `tee: no release log at stage ${into.tee.stage ?? 'unknown'} (${snapshot.logError ?? ''})`
        : `tee: could not read /v1/release/log: ${snapshot.logError ?? 'no answer'}`,
    );
    return;
  }
  const read = readReleaseLog(snapshot.log, target.examId);
  if ('refused' in read) {
    into.outcomes.push({ kind: 'log', source: 'tee', result: 'refused', detail: read.refused });
    return;
  }
  into.tee.servesExam = true;
  into.logs.push({ ...read, source: 'tee' });

  // The token is mirrored only from the instance that signed this log: that is the Unlock instance.
  try {
    const attestation = await readTeeAttestation(send, base);
    if (attestation.instancePublicKey.toLowerCase() !== read.instancePublicKey) {
      into.outcomes.push({
        kind: 'token',
        source: 'tee',
        result: 'held',
        detail: `the TEE's instance key ${short(attestation.instancePublicKey)} did not sign its log (${short(read.instancePublicKey)}), so its token is not the Unlock instance's`,
      });
      return;
    }
    if (typeof attestation.token !== 'string' || attestation.token === '') {
      into.outcomes.push({ kind: 'token', source: 'tee', result: 'refused', detail: '/v1/attestation has no token' });
      return;
    }
    into.tokens.push({ source: 'tee', body: new TextEncoder().encode(attestation.token), instancePublicKey: read.instancePublicKey, keyHash: read.keyHash });
  } catch (error) {
    into.notes.push(`tee: could not read /v1/attestation: ${describeTeeError(error)}`);
  }
}

function fromResult(kind: Kind, source: Source, key: string, result: MirrorResult, detail: string): Outcome {
  return result.written
    ? { kind, source, result: 'written', key, detail, entityKey: result.entityKey, ...(result.txHash ? { txHash: result.txHash } : {}) }
    : { kind, source, result: 'skipped', key, detail: 'already on Arkiv from this writer', entityKey: result.entityKey };
}

function fromError(kind: Kind, source: Source, key: string, error: unknown): Outcome {
  return error instanceof MirrorInputError
    ? { kind, source, result: 'refused', key, detail: error.message }
    : { kind, source, result: 'failed', key, detail: errorText(error) };
}

/** One pass: read, then write tokens, then logs. Only the writer's own errors become `failed`. */
export async function mirrorPass(target: MirrorTarget, deps: PassDeps, memo: Memo = newMemo()): Promise<PassReport> {
  const gathered: Gathered = { logs: [], tokens: [], outcomes: [], notes: [], tee: {} };
  await Promise.all([gatherStorage(target, deps.fetch, gathered), gatherTee(target, deps.fetch, gathered)]);
  const outcomes = [...gathered.outcomes];
  const base = { examId: target.examId, registry: target.registry, chainId: deps.chainId };

  const seenTokens = new Map<string, Source>();
  for (const token of gathered.tokens) {
    const firstSource = seenTokens.get(token.keyHash);
    if (firstSource) {
      outcomes.push({ kind: 'token', source: token.source, result: 'skipped', key: token.keyHash, detail: `same instance key as the ${firstSource} token`, ...entity(memo.tokens.get(token.keyHash)) });
      continue;
    }
    seenTokens.set(token.keyHash, token.source);
    const known = memo.tokens.get(token.keyHash);
    if (known) {
      outcomes.push({ kind: 'token', source: token.source, result: 'skipped', key: token.keyHash, detail: 'already mirrored in this run', entityKey: known });
      continue;
    }
    try {
      const result = await deps.writer.mirrorReleaseToken({ ...base, body: token.body, instancePublicKey: token.instancePublicKey });
      memo.tokens.set(token.keyHash, result.entityKey);
      outcomes.push(fromResult('token', token.source, token.keyHash, result, `instance ${short(token.instancePublicKey)}`));
    } catch (error) {
      outcomes.push(fromError('token', token.source, token.keyHash, error));
    }
  }

  const seenLogs = new Map<string, Source>();
  for (const log of gathered.logs) {
    const firstSource = seenLogs.get(log.entriesHash);
    if (firstSource) {
      outcomes.push({ kind: 'log', source: log.source, result: 'skipped', key: log.entriesHash, detail: `same entriesHash as the ${firstSource} log`, ...entity(memo.logs.get(log.entriesHash)) });
      continue;
    }
    seenLogs.set(log.entriesHash, log.source);
    if (!memo.tokens.has(log.keyHash)) {
      outcomes.push({ kind: 'log', source: log.source, result: 'held', key: log.entriesHash, detail: `no token for its signer ${short(log.instancePublicKey)} is on Arkiv yet; it is written after one is` });
      continue;
    }
    const known = memo.logs.get(log.entriesHash);
    if (known) {
      outcomes.push({ kind: 'log', source: log.source, result: 'skipped', key: log.entriesHash, detail: 'already mirrored in this run', entityKey: known });
      continue;
    }
    try {
      const result = await deps.writer.mirrorReleaseLog({ ...base, body: log.body });
      memo.logs.set(log.entriesHash, result.entityKey);
      outcomes.push(fromResult('log', log.source, log.entriesHash, result, `${String(log.entries)} entries`));
    } catch (error) {
      outcomes.push(fromError('log', log.source, log.entriesHash, error));
    }
  }

  const logs = gathered.logs.map(({ source, entriesHash, entries }) => ({ source, entriesHash, entries }));
  return { at: new Date(), outcomes, notes: gathered.notes, logs, tee: gathered.tee };
}

const entity = (key: Hex | undefined) => (key ? { entityKey: key } : {});

export function tally(report: PassReport): Record<Outcome['result'], number> {
  const counts = { written: 0, skipped: 0, held: 0, refused: 0, failed: 0 };
  for (const outcome of report.outcomes) counts[outcome.result] += 1;
  return counts;
}

/** The Arkiv explorer pages for a row, its transaction and a writer, from `arkiv.network.explorer`. */
export const explorerLinks = (explorer: string) => ({
  entity: (key: Hex) => `${explorer}/entity/${key}`,
  tx: (hash: Hash) => `${explorer}/tx/${hash}`,
  address: (address: Address) => `${explorer}/address/${address}`,
});
