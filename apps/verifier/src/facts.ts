import { arkiv } from '@paperseal/arkiv';
import type { PasskeyNameResult } from '@paperseal/chain';
import { ownerEnsName, roles, roundTimeSeconds, storageNames, toHex, type ApprovedListEntry, type Hex } from '@paperseal/protocol';
import type { Tone } from '@paperseal/ui';

import { approvedEntries } from './commitments';
import { roleNames, type Custody, type View } from './custody';
import { ARKIV_STALE_AFTER_SECONDS, isValidLog, roundReached, type ArkivReport, type LiveReport, type Records, type Release } from './load';
import type { Polled } from './poll';
import { releaseTokenName } from './storage';
import { swarmLogPassed, type SwarmCopy, type SwarmReport } from './swarm';

/*
 * What the sections under the chain of custody show, as data. Nothing here runs a check: every state
 * comes from a verdict made elsewhere, and a state is `checked` only if that check ran and passed. None
 * of it reaches a step, so a copy can't turn a step green.
 */

export const etherscan = 'https://sepolia.etherscan.io';

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/** `3 minutes 10 seconds`. */
export function duration(seconds: number): string {
  const whole = Math.round(Math.abs(seconds));
  if (whole < 60) return plural(whole, 'second');
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return whole % 60 === 0 ? plural(minutes, 'minute') : `${plural(minutes, 'minute')} ${plural(whole % 60, 'second')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(minutes % 60, 'minute')}`;
  return plural(Math.round(hours / 24), 'day');
}

/* ------------------------------------------------------------------ Releases */

/** The verified release log with the most entries. Unverified logs give nothing here. */
export function verifiedReleases(view: View): { releases: Release[]; source: 'storage' | 'arkiv' } | null {
  const records = view.records.state === 'ready' ? view.records.value : null;
  const log = records?.log.kind === 'ready' && isValidLog(records.log.verdict, records.log.token) ? (records.log.releases ?? null) : null;
  const report = view.arkiv.state === 'ready' && !('kind' in view.arkiv.value) ? view.arkiv.value : null;
  const mirrored = report?.log?.releases ?? null;
  if (log && (!mirrored || log.length >= mirrored.length)) return { releases: log, source: 'storage' };
  return mirrored ? { releases: mirrored, source: 'arkiv' } : null;
}

/* ------------------------------------------------------------------ People */

export interface NameState {
  tone: Tone;
  word: string;
  note?: string;
}

export interface Person {
  key: string;
  name: string;
  role: string;
  state: NameState;
  /** From a verified log only. Null when it holds no release from this person. */
  released: { round: bigint; at: number } | null;
  /** Whether this person is one who can release at all. */
  releases: boolean;
}

export interface People {
  holders: Person[];
  centres: Person[];
  /** Setters are listed by a code, never by name. */
  setters: string[];
  /** ENS names on the list, for saying who vouches for them. */
  names: string[];
  verified: boolean;
}

function nameState(entry: ApprovedListEntry, name: string | null, names: View['partyNames']): NameState {
  if (name === null) return { tone: 'warn', word: 'Not an ENS name' };
  const result: PasskeyNameResult | undefined = names?.state === 'ready' ? names.value[toHex(entry.passkeyPublicKey)] : undefined;
  if (result?.state === 'confirmed') return { tone: 'ok', word: 'Name confirmed' };
  if (result === undefined && (names === undefined || names.state === 'off')) return { tone: 'neutral', word: 'Not checked' };
  if (result === undefined && names?.state === 'loading') return { tone: 'neutral', word: 'Reading' };
  const note =
    result === undefined || result.state === 'refused' || result.state === 'unreadable' || result.state === 'invalid'
      ? 'This name could not be read just now.'
      : result.state === 'mismatch'
        ? 'The record on this name names a different security key.'
        : 'This name has no record for this security key yet.';
  return entry.role === roles.neutral ? { tone: 'warn', word: 'Not confirmed', note } : { tone: 'neutral', word: 'Label only', note };
}

export function people(view: View): People | null {
  const chain = view.records.state === 'ready' ? view.records.value.chain : null;
  const entries = approvedEntries(chain?.entries ?? null);
  if (!entries) return null;
  const log = verifiedReleases(view);
  const seen = new Map(log?.releases.map((release) => [release.passkeyPublicKey.toLowerCase(), release.round]));
  const person = (entry: ApprovedListEntry): Person => {
    const name = ownerEnsName(entry.owner);
    const key = toHex(entry.passkeyPublicKey);
    const round = seen.get(key.toLowerCase());
    return {
      key,
      name: name ?? entry.owner,
      role: roleNames[entry.role] ?? `Unknown role ${String(entry.role)}`,
      state: nameState(entry, name, view.partyNames),
      released: round === undefined ? null : { round, at: roundTimeSeconds(Number(round)) },
      releases: entry.role === roles.neutral || entry.role === roles.centre,
    };
  };
  const others = entries.filter((entry) => entry.role !== roles.setter);
  return {
    holders: others.filter((entry) => entry.role === roles.neutral).map(person),
    centres: others.filter((entry) => entry.role !== roles.neutral).map(person),
    setters: entries.filter((entry) => entry.role === roles.setter).map((entry) => entry.owner),
    names: others.flatMap((entry) => ownerEnsName(entry.owner) ?? []),
    verified: log !== null,
  };
}

/* ------------------------------------------------------------------ Timeline */

export interface Moment {
  id: string;
  label: string;
  /** Unix seconds. */
  at: number;
  round: bigint | null;
  happened: boolean;
  /** Against the schedule, in words. */
  note?: string;
}

/** The exam's moments in time order, each from the public record or a signed record. */
export function timeline(view: View): Moment[] {
  const chain = view.records.state === 'ready' ? view.records.value.chain : null;
  const exam = chain?.exam;
  if (!exam) return [];
  const { build, list } = chain;
  const { settings } = exam;
  const reached = (round: bigint) => roundReached(Number(round), view.latest.round, view.now);
  const lockAt = roundTimeSeconds(Number(settings.lockRound));
  const unlockAt = roundTimeSeconds(Number(settings.unlockRound));
  const moments: Moment[] = [
    { id: 'published', label: 'Exam published', at: Number(exam.createdAt), round: null, happened: true },
    ...(list ? [{ id: 'list', label: 'List of people posted', at: Number(list.postedAt), round: null, happened: true }] : []),
    { id: 'lock', label: 'Questions closed', at: lockAt, round: settings.lockRound, happened: reached(settings.lockRound) },
  ];
  if (build) {
    const builtAt = roundTimeSeconds(Number(build.builtRound));
    const gap = builtAt - lockAt;
    moments.push({
      id: 'built',
      label: 'Paper built and sealed',
      at: builtAt,
      round: build.builtRound,
      happened: true,
      note: gap >= 0 ? `${duration(gap)} after questions closed. On the public record ${duration(Number(build.postedAt) - builtAt)} later.` : `${duration(gap)} before questions closed.`,
    });
  }
  const enough = enoughReleased(view);
  moments.push({
    id: 'unlock',
    label: 'Paper unlocked for centres',
    at: unlockAt,
    round: settings.unlockRound,
    happened: reached(settings.unlockRound),
    ...(enough ? { note: `Enough key holders had released ${enough.at >= unlockAt ? `${duration(enough.at - unlockAt)} after this` : 'by this time'}.` } : {}),
  });
  moments.push({ id: 'start', label: 'Exam started', at: Number(settings.examStart), round: null, happened: view.now >= Number(settings.examStart) });
  moments.push({ id: 'end', label: 'Paper opened to everyone', at: roundTimeSeconds(Number(settings.endRound)), round: settings.endRound, happened: reached(settings.endRound) });
  return moments.sort((a, b) => a.at - b.at);
}

/** When the last release that was needed came in, from a verified log. */
function enoughReleased(view: View): { at: number } | null {
  const log = verifiedReleases(view);
  const needed = view.records.state === 'ready' && view.records.value.log.kind === 'ready' ? view.records.value.log.progress?.required : undefined;
  if (!log || needed === undefined || log.releases.length < needed) return null;
  const rounds = log.releases.map((release) => release.round).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const round = rounds[needed - 1];
  return round === undefined ? null : { at: roundTimeSeconds(Number(round)) };
}

/* ------------------------------------------------------------------ Copies */

export type CopyState = 'checked' | 'held' | 'missing' | 'unread' | 'off' | 'failed';
export type CopySource = 'registry' | 'bucket' | 'tee' | 'arkiv' | 'swarm';

export const sourceWords: Record<CopySource, string> = {
  registry: 'Exam record on Sepolia',
  bucket: 'Storage bucket',
  tee: 'Sealed machine',
  arkiv: 'Arkiv',
  swarm: 'Swarm',
};

export const stateWords: Record<CopyState, { word: string; tone: Tone }> = {
  checked: { word: 'Checked', tone: 'ok' },
  held: { word: 'Held, not checked', tone: 'neutral' },
  missing: { word: 'Not found', tone: 'neutral' },
  unread: { word: 'Could not be read', tone: 'neutral' },
  off: { word: 'Not used', tone: 'neutral' },
  failed: { word: 'Did not pass', tone: 'warn' },
};

export interface Copy {
  source: CopySource;
  state: CopyState;
  note: string;
  /** Unix seconds: when this copy was made. */
  at?: number;
  /** Which of this copy's links to show. */
  links?: { href: string; text: string }[];
  /** A Swarm reference or Arkiv entity key, for the evidence. */
  reference?: { label: string; value: string };
  /** This page's own answer came from this copy. */
  used?: boolean;
}

export type PieceId = 'log' | 'token' | 'paper' | 'keys';

export interface Piece {
  id: PieceId;
  label: string;
  /** What this piece is, in a few plain words. */
  about: string;
  copies: Copy[];
}

export interface Copies {
  pieces: Piece[];
  feed: Feed;
}

const pieceWords: Record<PieceId, { label: string; about: string }> = {
  log: { label: 'Record of releases', about: 'Who released their part of the key, signed by the sealed machine.' },
  token: { label: 'Proof of the machine', about: 'Google’s proof that the machine that took the releases ran the published code.' },
  paper: { label: 'Paper files', about: 'The sealed paper, and the list of its files.' },
  keys: { label: 'Keys', about: 'The files that open the paper for centres and, at the end, for everyone.' },
};

const servedFromSwarm = (records: Records | null, proof: View['proof'], name: string) =>
  records?.backup?.served.some((file) => file.name === name) === true || proof?.backup?.served.some((file) => file.name === name) === true;

/** What a read that gave nothing means here. */
function gap(kind: 'off' | 'neutral' | 'unavailable', message?: string): Pick<Copy, 'state' | 'note'> {
  if (kind === 'off') return { state: 'off', note: 'Add where the public files are kept under "Check it yourself".' };
  if (kind === 'unavailable') return { state: 'unread', note: message ? `This does not fail the exam. ${message}` : 'This does not fail the exam.' };
  return { state: 'missing', note: 'Not in the bucket.' };
}

function bucketLog(records: Records | null, stored: number | undefined): Copy {
  const base = { source: 'bucket' as const, ...(stored === undefined ? {} : { at: stored }) };
  const log = records?.log;
  if (!log) return { ...base, state: 'unread', note: 'Not read yet.' };
  if (log.kind === 'malformed') return { ...base, state: 'failed', note: 'This file can’t be read as a record of releases.' };
  if (log.kind !== 'ready') return { ...base, ...gap(log.kind, log.kind === 'unavailable' ? log.message : undefined) };
  if (isValidLog(log.verdict, log.token) && log.verdict.entriesHash === 'pass') return { ...base, state: 'checked', note: 'Its signature passed, under a key its proof attests.' };
  if (log.token?.verified !== true) return { ...base, state: 'held', note: 'Nothing has shown who signed it yet.' };
  return { ...base, state: 'failed', note: 'Its signature or contents did not pass.' };
}

function bucketToken(records: Records | null, stored: number | undefined): Copy {
  const base = { source: 'bucket' as const, ...(stored === undefined ? {} : { at: stored }) };
  const log = records?.log;
  if (log?.kind !== 'ready') return { ...base, state: 'missing', note: 'Checked with the record of releases, which is not here yet.' };
  if (!log.token) return { ...base, state: 'missing', note: 'Not in the bucket.' };
  return log.token.verified ? { ...base, state: 'checked', note: 'Google’s signature and every claim passed.' } : { ...base, state: 'failed', note: 'It does not attest the key that signed the record.' };
}

function manifestCopy(manifest: Records['manifest'] | undefined, source: 'bucket' | 'swarm'): Pick<Copy, 'state' | 'note'> {
  if (!manifest) return { state: 'unread', note: 'Not read yet.' };
  if (manifest.kind !== 'ready') return gap(manifest.kind, manifest.kind === 'unavailable' ? manifest.message : undefined);
  const { report } = manifest;
  if (report.hashCheck === 'fail' || report.kind === 'malformed' || report.examIdCheck === 'fail' || report.coverage.check === 'fail') {
    return { state: 'failed', note: 'Its list of files does not match the public record.' };
  }
  if (report.hashCheck === 'absent') return { state: 'held', note: 'No paper is recorded yet to check it against.' };
  const count = report.files.length;
  return { state: 'checked', note: `The list of ${plural(count, 'file')} matches the public record.${source === 'bucket' ? '' : ' Read through Swarm.'}` };
}

function bucketKeys(records: Records | null, stored: number | undefined): Copy {
  const base = { source: 'bucket' as const, ...(stored === undefined ? {} : { at: stored }) };
  const log = records?.log;
  if (log?.kind !== 'ready' || !log.files) return { ...base, state: 'missing', note: 'Checked against a signed record of releases, which is not here yet.' };
  const { files } = log;
  if (files.pending) return { ...base, state: 'missing', note: 'Not written yet. They are written once enough key holders release.' };
  if (files.check === 'pass') return { ...base, state: 'checked', note: `All ${plural(files.files.length, 'file')} match the signed record.` };
  if (files.check === 'fail') return { ...base, state: 'failed', note: 'A file is missing, or differs from the signed record.' };
  return { ...base, state: 'unread', note: 'Some files could not be read.' };
}

function arkivCopies(view: View): { log: Copy; token: Copy } {
  const entity = (key: Hex) => ({
    links: [{ href: `${arkiv.network.explorer}/entity/${key}`, text: 'Open in the Arkiv explorer' }],
    reference: { label: 'Arkiv entity key', value: key },
  });
  const same = (state: CopyState, note: string): { log: Copy; token: Copy } => ({ log: { source: 'arkiv', state, note }, token: { source: 'arkiv', state, note } });
  if (!view.sources.arkiv) return same('off', 'Add who may write the copy on Arkiv under "Check it yourself".');
  const polled = view.arkiv;
  if (polled.state === 'error') return same('unread', 'This does not fail the exam. This page keeps trying.');
  if (polled.state !== 'ready') return same('unread', 'Reading.');
  if ('kind' in polled.value) return same('missing', polled.value.message);
  const report: ArkivReport = polled.value;
  const { log, token } = report;
  const rows = (n: number) => (n > 1 ? ` ${plural(n, 'copy').replace('copys', 'copies')} on Arkiv.` : '');
  return {
    log: log
      ? { source: 'arkiv', state: 'checked', note: `It passed the same checks as the bucket’s copy.${rows(report.read.logs)}`, at: log.writtenAt, ...entity(log.entityKey) }
      : report.read.logs > 0
        ? { source: 'arkiv', state: 'held', note: 'Rows are there, but none has passed its check yet.' }
        : { source: 'arkiv', state: 'missing', note: 'No row on Arkiv yet.' },
    token: token
      ? { source: 'arkiv', state: 'checked', note: `It passed the same checks as the bucket’s copy.${rows(report.read.tokens)}`, at: token.writtenAt, ...entity(token.entityKey) }
      : report.read.tokens > 0
        ? { source: 'arkiv', state: 'held', note: 'Rows are there, but none has passed its check yet.' }
        : { source: 'arkiv', state: 'missing', note: 'No row on Arkiv yet.' },
  };
}

function teeCopy(view: View, over: boolean): Copy {
  const report: LiveReport | null = view.live.state === 'ready' && !('kind' in view.live.value) ? view.live.value : null;
  if (!view.sources.tee) return { source: 'tee', state: 'off', note: 'No live machine is set up here.' };
  if (over || view.live.state === 'off') return { source: 'tee', state: 'off', note: 'Not asked. This exam is judged from what was recorded while it ran.' };
  if (report?.otherExam) return { source: 'tee', state: 'off', note: 'It is serving another exam now. That does not affect this one.' };
  if (report?.fresh.ok === true && report.fresh.value.trusted) return { source: 'tee', state: 'held', note: 'It gives progress so far. Only the record counts.' };
  return { source: 'tee', state: 'held', note: 'It has not shown it is running this exam, so nothing it says is used.' };
}

const rank: Record<CopyState, number> = { checked: 0, held: 1, unread: 2, failed: 3, missing: 4, off: 5 };

function swarmCopy(polled: Polled<SwarmReport> | undefined, judge: (copy: SwarmCopy) => Pick<Copy, 'state' | 'note'>): Copy {
  if (!polled || polled.state === 'off') return { source: 'swarm', state: 'off', note: 'Backups are found through Arkiv, which is not set up here.' };
  if (polled.state === 'loading') return { source: 'swarm', state: 'unread', note: 'Reading.' };
  if (polled.state === 'error') return { source: 'swarm', state: 'unread', note: `No backup could be looked up just now. This does not fail the exam. ${polled.message}` };
  const { copies } = polled.value;
  if (copies.length === 0) return { source: 'swarm', state: 'missing', note: 'No backup is recorded for this exam.' };
  const judged = copies.map((copy) => ({ copy, ...judge(copy) }));
  const best = judged.reduce((a, b) => (rank[b.state] < rank[a.state] ? b : a));
  return {
    source: 'swarm',
    state: best.state,
    note: best.note,
    at: best.copy.writtenAt,
    links: [
      { href: best.copy.url, text: 'Open on Swarm' },
      { href: `${arkiv.network.explorer}/entity/${best.copy.row.entityKey}`, text: 'Open the backup row in the Arkiv explorer' },
    ],
    reference: { label: 'Swarm reference', value: best.copy.row.swarmRef },
  };
}

const noApi = { state: 'held', note: 'A backup is recorded, but no Swarm node is set up here to read it. Add one under "Check it yourself".' } as const;

function swarmSource(source: { kind: string; message?: string } | undefined, words: string): Pick<Copy, 'state' | 'note'> {
  if (source?.kind === 'unavailable') return { state: 'unread', note: `The backup could not be read just now. This does not fail the exam. ${source.message ?? ''}`.trim() };
  if (source?.kind === 'malformed') return { state: 'failed', note: 'This backup’s copy can’t be read, so it would not be used.' };
  return { state: 'missing', note: words };
}

export const swarmJudges: Record<PieceId, (copy: SwarmCopy) => Pick<Copy, 'state' | 'note'>> = {
  log: (copy) => {
    const log = copy.read?.log;
    if (!copy.read) return noApi;
    if (log?.kind !== 'ready') return swarmSource(log, 'This backup was made before the release.');
    return swarmLogPassed(copy)
      ? { state: 'checked', note: 'It passed the same checks as the bucket’s copy.' }
      : { state: 'failed', note: 'This copy did not pass, so it would not be used. This does not fail the exam.' };
  },
  token: (copy) => {
    const log = copy.read?.log;
    if (!copy.read) return noApi;
    if (log?.kind !== 'ready') return swarmSource(log, 'This backup was made before the release.');
    if (!log.token) return { state: 'missing', note: 'Not in this backup.' };
    return log.token.verified ? { state: 'checked', note: 'Google’s signature and every claim passed.' } : { state: 'failed', note: 'This copy did not pass, so it would not be used. This does not fail the exam.' };
  },
  paper: (copy) => (copy.read ? manifestCopy(copy.read.manifest, 'swarm') : noApi),
  keys: (copy) => {
    const log = copy.read?.log;
    if (!copy.read) return noApi;
    if (log?.kind !== 'ready') return swarmSource(log, 'This backup was made before the release.');
    if (!log.files || log.files.pending) return { state: 'missing', note: 'Not in this backup.' };
    if (log.files.check === 'pass') return { state: 'checked', note: `All ${plural(log.files.files.length, 'file')} match the signed record.` };
    return log.files.check === 'fail'
      ? { state: 'failed', note: 'A file differs from the signed record, so it would not be used. This does not fail the exam.' }
      : { state: 'unread', note: 'Some files could not be read just now. This does not fail the exam.' };
  },
};

const mark = (copies: Copy[], used: CopySource | null): Copy[] => copies.map((copy) => (copy.source === used ? { ...copy, used: true } : copy));

/** Every piece of evidence and each place that holds it, with which one this page's answer came from. */
export function copies(view: View, result: Pick<Custody, 'progressSource'>, swarm?: Polled<SwarmReport>): Copies | null {
  const records = view.records.state === 'ready' ? view.records.value : null;
  if (!records?.chain.exam) return null;
  const { chain } = records;
  if (!chain.exam) return null;
  const { proof } = view;
  const over = roundReached(Number(chain.exam.settings.endRound), view.latest.round, view.now);
  const stored = records.stored ?? {};
  const mirror = arkivCopies(view);
  const tee = teeCopy(view, over);
  const opened = proof?.ok === true && proof.result.state === 'opened';

  const fromSwarm = (name: string) => servedFromSwarm(records, proof, name);
  const logUsed: CopySource | null =
    fromSwarm(storageNames.releaseLog) ? 'swarm' : result.progressSource === 'storage' ? 'bucket' : result.progressSource === 'arkiv' ? 'arkiv' : result.progressSource === 'tee' ? 'tee' : null;
  const tokenBucket = bucketToken(records, stored[releaseTokenName]);
  const tokenUsed: CopySource | null = fromSwarm(releaseTokenName) ? 'swarm' : tokenBucket.state === 'checked' ? 'bucket' : mirror.token.state === 'checked' ? 'arkiv' : null;
  const paperUsed: CopySource | null = fromSwarm(storageNames.paper) || fromSwarm(storageNames.manifest) ? 'swarm' : records.manifest.kind === 'ready' ? 'bucket' : null;
  const keysUsed: CopySource | null = fromSwarm(storageNames.keyPriv) ? 'swarm' : opened ? 'bucket' : null;

  const { build } = chain;
  const registry: Copy = build
    ? {
        source: 'registry',
        state: 'checked',
        note: 'It holds the fingerprint every copy must match, not the files.',
        at: Number(build.postedAt),
        reference: { label: 'Fingerprint of the file list', value: build.storageManifestHash },
      }
    : { source: 'registry', state: 'missing', note: 'No paper is recorded yet.' };

  const piece = (id: PieceId, list: Copy[], used: CopySource | null): Piece => ({ id, ...pieceWords[id], copies: mark(list, used) });
  return {
    pieces: [
      piece('log', [bucketLog(records, stored[storageNames.releaseLog]), mirror.log, swarmCopy(swarm, swarmJudges.log), tee], logUsed),
      piece('token', [tokenBucket, mirror.token, swarmCopy(swarm, swarmJudges.token)], tokenUsed),
      piece('paper', [registry, { source: 'bucket', ...manifestCopy(records.manifest, 'bucket'), ...(stored[storageNames.manifest] === undefined ? {} : { at: stored[storageNames.manifest] }) }, swarmCopy(swarm, swarmJudges.paper)], paperUsed),
      piece('keys', [bucketKeys(records, stored[storageNames.keyPriv]), swarmCopy(swarm, swarmJudges.keys)], keysUsed),
    ],
    feed: feed(view, over),
  };
}

/* ------------------------------------------------------------------ The relay */

export interface Feed {
  state: 'off' | 'unread' | 'silent' | 'fresh' | 'stopped' | 'quiet';
  text: string;
  /** The newest heartbeat, if one is still kept. */
  heartbeat?: { at: number; stage: string };
  /** When the relay last wrote anything for this exam. */
  lastWrite?: number;
}

function feed(view: View, over: boolean): Feed {
  if (!view.sources.arkiv) return { state: 'off', text: 'The copy on Arkiv is not set up here.' };
  const polled = view.arkiv;
  if (polled.state === 'error') return { state: 'unread', text: 'The relay’s feed could not be read just now. This does not fail the exam.' };
  if (polled.state !== 'ready' || 'kind' in polled.value) return { state: 'unread', text: 'Reading the relay’s feed.' };
  const report = polled.value;
  const exam = view.records.state === 'ready' ? view.records.value.chain.exam : null;
  const open = exam ? roundReached(Number(exam.settings.unlockRound), view.latest.round, view.now) && !over : false;
  const heartbeat = report.heartbeat ? { heartbeat: { at: report.heartbeat.writtenAt, stage: report.heartbeat.stage } } : {};
  const lastWrite = report.newestAt === null ? {} : { lastWrite: report.newestAt };
  const age = report.ageSeconds;
  if (open && age === null) return { state: 'silent', text: 'The relay has not written since release opened. That does not mean no one has released.' };
  if (open && age !== null && age > ARKIV_STALE_AFTER_SECONDS) {
    return { state: 'stopped', text: `The relay stopped updating ${duration(age)} ago. That does not mean no one has released since.`, ...heartbeat, ...lastWrite };
  }
  if (open) return { state: 'fresh', text: 'The relay is running and its feed is up to date.', ...heartbeat, ...lastWrite };
  return { state: 'quiet', text: 'The relay only writes while key holders release, so a quiet feed is normal now.', ...heartbeat, ...lastWrite };
}

/** How many separate places hold a passing copy of the record of releases. */
export const checkedCopies = (found: Copies | null, id: PieceId = 'log'): number =>
  found?.pieces.find((piece) => piece.id === id)?.copies.filter((copy) => copy.state === 'checked').length ?? 0;

