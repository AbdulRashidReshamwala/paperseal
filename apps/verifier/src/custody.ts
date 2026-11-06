import type { ClaimCheck } from '@paperseal/attestation';
import {
  decodeApprovedList,
  decodeCriteria,
  fromHex,
  requireHardwareAttestation,
  roles,
  roundAtSeconds,
  roundTimeSeconds,
  storageNames,
  type ApprovedListEntry,
  type Hex,
  type Paper,
} from '@paperseal/protocol';
import type { CheckStatus, SealState, StepState, Tone } from '@paperseal/ui';

import type { Build, Exam } from './attest';
import { chainChecks, computedListHash, sameHex, type ChainData, type ChainProblem, type CheckResult } from './checks';
import { roundStatus, type LatestRound } from './live';
import {
  roundReached,
  type LiveReport,
  type ManifestResult,
  type Neutral,
  type ProofRun,
  type Records,
  type Sourced,
} from './load';
import type { Polled } from './poll';
import type { ProofChecks } from './proof';
import type { LogVerdict, ReleaseProgress } from './unlock';

/*
 * Turns everything the checks found into the chain of custody. It decides what each step's state
 * is and says so in words, and it runs no check of its own: every verdict comes from checks.ts,
 * attest.ts, commitments.ts, unlock.ts or proof.ts.
 *
 * A step's evidence is data, not markup, so its state can't disagree with it. Any Fail row fails
 * its step and reaches the top of the page, and a step can only be done when `complete` says so.
 */

export const defaultRepository = 'AbdulRashidReshamwala/paperseal';

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The repository the code and build links point at: VITE_RELEASES_REPO, or the default. A fork
 * sets it to its own `owner/name`, the same variable the board app reads its releases from.
 */
export function repository(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
): string {
  const given = env.VITE_RELEASES_REPO?.trim();
  if (!given) return defaultRepository;
  if (!repositoryPattern.test(given)) throw new Error(`VITE_RELEASES_REPO must look like owner/name, not "${given}".`);
  return given;
}

export const REPOSITORY = repository();

export type Label = string | { code: string };

export type Item =
  | {
      kind: 'check';
      label: Label;
      status: CheckStatus;
      detail?: string;
      hash?: string;
      /** The specific sentence for the top of the page if this fails. */
      failure?: string;
      /** A summary of rows that each report their own failure. */
      quiet?: boolean;
    }
  | { kind: 'hash'; label: Label; value: string }
  | { kind: 'fact'; label: Label; value: string }
  | { kind: 'tag'; label: Label; tone: Tone; tag: string; value?: string; hash?: string }
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; tone?: 'warn' }
  | { kind: 'countdown'; at: number; round: number; label: string; reached: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; text: string };

export type StepId = 'published' | 'attested' | 'people' | 'locked' | 'sealed' | 'unlock' | 'open';

export interface CustodyStep {
  id: StepId;
  number: number;
  label: string;
  state: StepState;
  /** Unix seconds, for the clock time. */
  at: number | null;
  /** The public clock round at that moment. */
  round: number | null;
  note: string;
  items: Item[];
  /** Every failed check here, as plain sentences. */
  failures: string[];
}

export interface Failure {
  step: number;
  label: string;
  message: string;
}

export interface Custody {
  steps: CustodyStep[];
  failures: Failure[];
  /** Null until the code has established a seal state. Never a stand-in for a check not run. */
  seal: SealState | null;
  /** Why the seal is not shown. */
  noSeal: string;
  headline: string;
  verdict: string;
  next: string;
  /** Present only when the proof opened the paper and it matches the Build. */
  paper: Paper | null;
  withheld: boolean;
}

export interface View {
  examId: Hex | null;
  /** The URL named something that is not an exam ID. */
  invalidLink: boolean;
  sources: { chain: boolean; storage: boolean; tee: boolean };
  records: Polled<Records>;
  live: Polled<LiveReport | Neutral>;
  latest: LatestRound;
  /** Unix seconds. */
  now: number;
  proof: ProofRun | null;
  /** For tests. */
  timeZone?: string;
}

const needsStorage = 'Needs the storage address, which you can add under "Check against your own RPC".';
const needsTee = 'Needs a TEE URL, which you can add under "Check against your own RPC". Every chain check works without it.';

const roleNames: Record<number, string> = {
  1: 'Setter',
  2: 'Neutral party',
  3: 'Centre, key holder',
  4: 'Approved centre',
};

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/** `in 14 minutes`. Precise enough to read, and it never pretends to be the clock. */
export function inWords(seconds: number): string {
  if (seconds <= 0) return 'any moment now';
  if (seconds < 60) return 'in under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${plural(minutes, 'minute')}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 6 && rest > 0) return `in ${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
  if (hours < 48) return `in ${plural(Math.round(minutes / 60), 'hour')}`;
  return `in ${plural(Math.round(hours / 24), 'day')}`;
}

const inZone = (timeZone?: string) => (timeZone ? { timeZone } : {});

/** `Sat 7 Nov, 21:30`, in the viewer's own time zone. */
export function dayTime(seconds: number, timeZone?: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...inZone(timeZone) });
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...inZone(timeZone) });
  return `${day.format(seconds * 1000).replace(',', '')}, ${time.format(seconds * 1000)}`;
}

/** `21:30` today, and `Sat 7 Nov, 21:30` on any other day. */
export function clockTime(seconds: number, now: number, timeZone?: string): string {
  const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', ...inZone(timeZone) });
  const full = dayTime(seconds, timeZone);
  return date.format(seconds * 1000) === date.format(now * 1000) ? full.slice(full.indexOf(', ') + 2) : full;
}

/** The exact moment, in UTC, for evidence someone may compare elsewhere. */
export const utcTime = (seconds: number) => `${new Date(seconds * 1000).toISOString().replace('.000Z', '')} UTC`;

const short = (value: unknown) => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined');
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
};

type CheckItem = Extract<Item, { kind: 'check' }>;

const fail = (label: Label, failure: string, detail?: string): CheckItem => ({
  kind: 'check',
  label,
  status: 'fail',
  failure,
  ...(detail ? { detail } : {}),
});

/** Pass or Fail, or neutral when there is nothing to compare yet. */
function verdict(label: Label, result: CheckResult | boolean, words: { failure: string; absent?: string; hash?: string }): Item {
  const outcome = result === true ? 'pass' : result === false ? 'fail' : result;
  const hash = words.hash ? { hash: words.hash } : {};
  if (outcome === 'pass') return { kind: 'check', label, status: 'pass', ...hash };
  if (outcome === 'fail') return { kind: 'check', label, status: 'fail', failure: words.failure, ...hash };
  return { kind: 'check', label, status: 'not-checked', detail: words.absent ?? 'Not posted', ...hash };
}

/** A check that has not run, with the reason in words. */
const notChecked = (label: Label, detail: string): Item => ({ kind: 'check', label, status: 'not-checked', detail });

/** A source that gave no answer: neutral, and never a pass. */
function sourceGap(label: string, source: Neutral | { kind: 'off' } | { kind: 'unavailable'; message: string }): Item {
  if (source.kind === 'off') return notChecked(label, needsStorage);
  if (source.kind === 'neutral') return notChecked(label, source.message);
  return notChecked(label, `Could not be read: ${source.message}`);
}

/** A record that is on-chain but whose bytes can't be used. Never shown as "not posted". */
function problemRow(label: string, problem: ChainProblem): Item {
  return problem.kind === 'mismatch'
    ? fail(label, `${label}: the bytes on the public record do not match its fingerprint. ${problem.message}`, problem.message)
    : notChecked(label, `Could not be read: ${problem.message}`);
}

function claimRow(check: ClaimCheck): Item {
  if (check.ok) return { kind: 'check', label: { code: check.claim }, status: 'pass', detail: short(check.actual) };
  const detail = `${short(check.actual)}, expected ${short(check.expected)}${check.note ? ` (${check.note})` : ''}`;
  return fail({ code: check.claim }, `The proof's ${check.claim} claim does not match: ${detail}.`, detail);
}

interface Draft {
  id: StepId;
  label: string;
  /** Whether the step is finished. A failed row overrides this. */
  complete: boolean;
  /** The step can't be finished, because an earlier one never happened. */
  notApplicable?: boolean;
  /** Whether a viewer is waiting on this step now. A step whose proof comes later never blocks. */
  blocks?: boolean;
  at?: number | null;
  round?: number | null;
  note: string;
  items: Item[];
}

interface Context {
  view: View;
  chain: ChainData | null;
  exam: Exam | null;
  build: Build | null;
  /** The headline chain checks, or null before the first read. */
  checks: ReturnType<typeof chainChecks> | null;
  records: Records | null;
  live: LiveReport | null;
  lockReached: boolean;
  unlockReached: boolean;
  endReached: boolean;
  /** `Fri 21:30, in 14 minutes`. */
  when: (seconds: number) => string;
}

const roundOf = (seconds: number | null) => (seconds === null ? null : roundAtSeconds(seconds) || null);

function roundRow(label: string, round: bigint, c: Context): Item {
  const at = roundTimeSeconds(Number(round));
  const status = roundStatus(Number(round), c.view.latest.round, c.view.now);
  const base = { kind: 'tag' as const, label: `${label}, round ${String(round)}`, value: utcTime(at) };
  if (status.published) return { ...base, tone: 'ok', tag: 'Published' };
  const tag = status.remaining > 0 ? 'Not yet' : 'Due, waiting for the public clock';
  return { ...base, tone: 'neutral', tag: status.drandKnown ? tag : `${tag} (this device's clock, public clock not reached)` };
}

function settingsItems(exam: Exam, examId: Hex | null): Item[] {
  const s = exam.settings;
  return [
    ...(examId ? [{ kind: 'hash' as const, label: 'Exam ID', value: examId }] : []),
    { kind: 'fact', label: 'T, exam start', value: utcTime(Number(s.examStart)) },
    { kind: 'fact', label: 'Δ', value: `${String(s.delta)} s` },
    { kind: 'fact', label: `Lock round ${String(s.lockRound)}`, value: utcTime(roundTimeSeconds(Number(s.lockRound))) },
    { kind: 'fact', label: `Unlock round ${String(s.unlockRound)}`, value: utcTime(roundTimeSeconds(Number(s.unlockRound))) },
    { kind: 'fact', label: `End round ${String(s.endRound)}`, value: utcTime(roundTimeSeconds(Number(s.endRound))) },
    { kind: 'hash', label: 'Criteria hash', value: s.criteriaHash },
    { kind: 'fact', label: 'RPC host the sealed machine reads', value: s.rpcHost },
    { kind: 'hash', label: 'TEE version, the commit it was built from', value: exam.commitHash },
    { kind: 'hash', label: 'TEE image digest', value: exam.imageDigest },
    { kind: 'link', href: `https://github.com/${REPOSITORY}/commit/${exam.commitHash.slice(2)}`, text: 'Read this version of the code' },
  ];
}

function publishedStep(c: Context): Draft {
  const { exam } = c;
  const seconds = exam ? Number(exam.createdAt) : null;
  return {
    id: 'published',
    label: 'Exam published',
    complete: exam !== null,
    at: seconds,
    round: roundOf(seconds),
    note: exam
      ? "The exam's rules and the exact version of the sealed machine's code are on the public record."
      : 'The exam board has not published this exam.',
    items: exam
      ? [{ kind: 'check', label: 'Exam published', status: 'pass', detail: 'Published' }, ...settingsItems(exam, c.view.examId)]
      : [notChecked('Exam published', 'Not published')],
  };
}

function publishedTokenItems(token: Records['token'] | null): Item[] {
  if (!token) return [notChecked('Published proof', 'Not read yet')];
  if (token.kind !== 'ready') return [sourceGap('Published proof', token)];
  const { verdict: result, build } = token;
  const recordFailed = !result.signature.ok || result.claims.some((claim) => !claim.ok);
  return [
    {
      kind: 'check',
      label: 'Whole token, signature and claims and the Build signature',
      status: result.verified ? 'pass' : 'fail',
      ...(result.verified
        ? {}
        : { quiet: recordFailed, failure: 'The Build is not signed by the key in the machine proof. See step 5.' }),
    },
    result.signature.ok
      ? { kind: 'check', label: "Token signature, up to Google's root", status: 'pass' }
      : fail(
          "Token signature, up to Google's root",
          `The machine proof's signature does not lead to Google: ${result.signature.error.message}`,
          result.signature.error.message,
        ),
    ...result.claims.map(claimRow),
    { kind: 'hash', label: 'Instance key', value: build.instancePublicKey },
  ];
}

function liveTokenItems(c: Context): Item[] {
  const heading: Item = { kind: 'heading', text: 'Live from the sealed machine, optional' };
  if (!c.view.sources.tee) return [heading, { kind: 'text', text: needsTee }];
  const { live } = c.view;
  const unpublished = 'The exam is not published on the chain yet.';
  if (live.state === 'error') return [heading, notChecked('Fresh token', `Could not be read: ${live.message}`)];
  if (live.state !== 'ready') return [heading, notChecked('Fresh token', c.exam ? 'Not read yet' : unpublished)];
  if ('kind' in live.value) return [heading, notChecked('Fresh token', live.value.message)];
  const { fresh } = live.value;
  if (!fresh.ok) return [heading, notChecked('Fresh token', `Could not be read: ${fresh.message}`)];
  const result = fresh.value;
  return [
    heading,
    {
      kind: 'check',
      label: 'Trusted: token signature, every claim and the instance key signature',
      status: result.trusted ? 'pass' : 'fail',
      quiet: true,
      failure: 'The live sealed machine did not pass its check.',
    },
    result.signature.ok
      ? { kind: 'check', label: "Token signature, up to Google's root", status: 'pass' }
      : fail(
          "Token signature, up to Google's root",
          `The live machine's proof does not lead to Google: ${result.signature.error.message}`,
          result.signature.error.message,
        ),
    ...result.claims.map(claimRow),
    result.instanceKey.ok
      ? { kind: 'check', label: 'Instance key signs the encryption key', status: 'pass' }
      : fail('Instance key signs the encryption key', `The live machine's keys do not match: ${result.instanceKey.error}`, result.instanceKey.error),
    { kind: 'hash', label: 'Instance key', value: result.instancePublicKey },
  ];
}

function rebuildItems(exam: Exam): Item[] {
  const commit = exam.commitHash.slice(2);
  return [
    { kind: 'heading', text: 'Rebuild it yourself' },
    {
      kind: 'text',
      text: 'The Reproducible build action rebuilds this commit twice on a clean GitHub runner and fails if the digest differs from the one on the public record. Nothing here depends on it, but anyone can run it.',
    },
    { kind: 'link', href: `https://github.com/${REPOSITORY}/actions/workflows/repro.yml`, text: 'Open the Reproducible build action' },
    {
      kind: 'code',
      text: `gh workflow run repro.yml -R ${REPOSITORY} -f commit=${commit} -f expected_digest=sha256:${exam.imageDigest.slice(2)}`,
    },
  ];
}

const demoWarning =
  'Demo mode. The sealed machine does not check where security keys come from, so a simulated key could be registered as a key holder, setter or centre.';

function attestedStep(c: Context): Draft {
  const { exam, build, live } = c;
  const token = c.records?.token ?? null;
  const published = token?.kind === 'ready' ? token : null;
  const freshPassed = live?.fresh.ok === true && live.fresh.value.trusted;
  const hardware: Item[] = [
    {
      kind: 'tag',
      label: { code: 'requireHardwareAttestation' },
      tone: requireHardwareAttestation ? 'ok' : 'warn',
      tag: String(requireHardwareAttestation),
    },
    {
      kind: 'text',
      ...(requireHardwareAttestation
        ? { text: 'The sealed machine checks that every registered security key comes from approved hardware.' }
        : { text: demoWarning, tone: 'warn' as const }),
    },
    { kind: 'text', text: "This is the value in spec/constants.json when this verifier was built. The sealed machine's own value is part of its attested image." },
  ];
  const complete = published?.verdict.verified === true || (build === null && freshPassed);
  const demo = requireHardwareAttestation ? '' : ' This is a demonstration: its security keys are simulated.';
  const note = published?.verdict.verified
    ? `Google's signed proof says the sealed machine runs the published code.${demo}`
    : complete
      ? `Checked live just now. The permanent proof is published with the paper.${demo}`
      : build
        ? `The permanent proof has not been checked yet.${demo}`
        : `The proof is published with the paper.${demo}`;
  const at = published?.issuedAt ?? null;
  return {
    id: 'attested',
    label: 'Sealed machine running the published code',
    complete,
    blocks: build !== null,
    at,
    round: roundOf(at),
    note,
    items: [
      { kind: 'heading', text: 'Published proof' },
      ...publishedTokenItems(token),
      ...liveTokenItems(c),
      { kind: 'heading', text: 'Security key hardware' },
      ...hardware,
      ...(exam ? rebuildItems(exam) : []),
    ],
  };
}

function listSummary(entries: readonly ApprovedListEntry[]): string {
  const count = (test: (role: number) => boolean) => entries.filter((entry) => test(entry.role)).length;
  const setters = count((role) => role === roles.setter);
  const neutrals = count((role) => role === roles.neutral);
  const centres = count((role) => role !== roles.setter && role !== roles.neutral);
  const people = entries.length === 1 ? '1 person' : `${String(entries.length)} people`;
  const parties = neutrals === 1 ? '1 neutral party' : `${String(neutrals)} neutral parties`;
  return `${people} approved: ${plural(setters, 'setter')}, ${parties} and ${plural(centres, 'centre')}.`;
}

function entryRows(bytes: Uint8Array): { items: Item[]; entries: ApprovedListEntry[] | null } {
  try {
    const entries = decodeApprovedList(bytes);
    return {
      entries,
      items: entries.map((entry) =>
        entry.role === roles.setter
          ? { kind: 'hash', label: 'Setter', value: entry.owner }
          : { kind: 'fact', label: roleNames[entry.role] ?? `Unknown role ${String(entry.role)}`, value: entry.owner },
      ),
    };
  } catch (error) {
    const message = (error as Error).message;
    return { entries: null, items: [fail('List decode', `The approved list on the public record can't be read: ${message}`, message)] };
  }
}

function peopleStep(c: Context): Draft {
  const { chain, view, build } = c;
  const at = chain?.list ? Number(chain.list.postedAt) : null;
  const base = { id: 'people' as const, label: 'People approved', at, round: roundOf(at) };
  const problem = chain?.problems?.list;
  if (problem) {
    return {
      ...base,
      complete: false,
      note: 'The list is on the public record, but it could not be used.',
      items: [problemRow('Approved list', problem)],
    };
  }
  if (!view.examId || !chain?.entries || !chain.list) {
    return {
      ...base,
      complete: false,
      note: 'The exam board has not published the approved list.',
      items: [notChecked('Approved list', 'Not posted')],
    };
  }
  const bytes = fromHex(chain.entries);
  const computed = computedListHash(view.examId, bytes);
  const hashOk = c.checks?.list === 'pass';
  const rows = entryRows(bytes);
  return {
    ...base,
    complete: hashOk && rows.entries !== null,
    note: rows.entries ? listSummary(rows.entries) : 'The list could not be read.',
    items: [
      verdict('List hash matches the chain', hashOk, {
        failure: 'The approved list does not match the fingerprint on the public record.',
        hash: computed,
      }),
      build
        ? verdict("Build's approved list hash", sameHex(build.approvedListHash, computed), {
            failure: 'The paper was built against a different approved list from the one published.',
            hash: build.approvedListHash,
          })
        : notChecked("Build's approved list hash", 'No Build yet'),
      ...rows.items,
    ],
  };
}

function criteriaItems(c: Context): { items: Item[]; ok: boolean } {
  const { exam, chain, checks } = c;
  if (!exam) return { items: [notChecked('Criteria', 'Not published')], ok: false };
  const problem = chain?.problems?.criteria;
  if (problem) return { items: [problemRow('Criteria', problem)], ok: false };
  if (!chain?.criteria) return { items: [notChecked('Criteria', 'Not published')], ok: false };
  const bytes = fromHex(chain.criteria);
  const hashOk = checks?.criteria === 'pass';
  const hashRow = verdict('Criteria hash matches the exam', hashOk, {
    failure: 'The selection criteria do not match the fingerprint on the public record.',
  });
  let decoded;
  try {
    decoded = decodeCriteria(bytes);
  } catch (error) {
    const message = (error as Error).message;
    return { ok: false, items: [hashRow, fail('Criteria decode', `The selection criteria can't be read: ${message}`, message)] };
  }
  return {
    ok: hashOk,
    items: [
      hashRow,
      { kind: 'fact', label: "Most of a topic's question bank one setter can hold", value: `${String(decoded.maxSetterPercent)}%` },
      { kind: 'fact', label: "Question bank size, times the topic's question count", value: `${String(decoded.minBankMultiple)}x` },
      ...decoded.topics.map((topic): Item => ({ kind: 'fact', label: `Topic: ${topic.name}`, value: `${String(topic.questions)} questions` })),
    ],
  };
}

/** What the attested machine says when it has stopped the exam. Unverified, it is not evidence of anything. */
function machineFailed(c: Context): Item[] {
  const { live } = c;
  const reported = live?.fresh.ok === true && live.fresh.value.trusted && live.status.ok && live.status.value.stage === 'failed';
  return reported
    ? [fail('Sealed machine status, live', 'The sealed machine, which passed its live check, reports that this exam has failed and cannot go ahead.')]
    : [];
}

function lockedStep(c: Context): Draft {
  const { exam, build } = c;
  const lockAt = exam ? roundTimeSeconds(Number(exam.settings.lockRound)) : null;
  const { items, ok } = criteriaItems(c);
  const note = build
    ? `${plural(Number(build.selected), 'question')} chosen from a question bank of ${String(build.bankSize)}.`
    : !exam || lockAt === null
      ? 'Waiting for the exam to be published.'
      : c.lockReached
        ? 'Lock time has passed. The size of the question bank is published with the paper.'
        : `Setters can send questions until ${c.when(lockAt)}.`;
  return {
    id: 'locked',
    label: 'Questions locked',
    complete: ok && build !== null,
    at: lockAt,
    round: exam ? Number(exam.settings.lockRound) : null,
    note,
    items: [
      ...items,
      build
        ? { kind: 'fact', label: 'Selected from question bank', value: `${String(build.selected)} of ${String(build.bankSize)}` }
        : notChecked('Selected from question bank', 'No Build yet'),
      ...(exam ? [roundRow('Lock', exam.settings.lockRound, c)] : []),
      ...(build ? [] : machineFailed(c)),
    ],
  };
}

function buildSignatureItem(token: Records['token'] | null): { item: Item; ok: boolean } {
  const label = "Build signed by the token's instance key";
  if (token?.kind !== 'ready') return { item: notChecked(label, 'Not checked until the published proof is read'), ok: false };
  const { build } = token.verdict;
  return build.ok
    ? { item: { kind: 'check', label, status: 'pass' }, ok: true }
    : { item: fail(label, `The Build's signature does not check out: ${build.error ?? 'it does not verify'}.`, build.error), ok: false };
}

function manifestItems(result: Sourced<ManifestResult>): { items: Item[]; ok: boolean } {
  if (result.kind !== 'ready') return { items: [sourceGap('Storage manifest', result)], ok: false };
  const { report, owners } = result;
  const hashRow = verdict("Manifest hash matches the Build's storageManifestHash", report.hashCheck, {
    failure: 'The list of published files is not the one the Build committed to.',
    absent: 'No Build yet',
    hash: report.hash,
  });
  if (report.kind === 'malformed') {
    return { ok: false, items: [hashRow, fail('Manifest format', `The list of published files can't be read: ${report.error}`, report.error)] };
  }
  const coverage = verdict('Lists every file, with one share per key holder on the approved list', report.coverage.check, {
    failure: `The published files are incomplete: ${report.coverage.error ?? 'they do not match the approved list'}.`,
    absent: 'No approved list yet',
  });
  const files = report.files.map((file): Item => {
    if (!file.recipient) return { kind: 'hash', label: { code: file.name }, value: file.sha256 };
    const owner = owners[file.recipient] ?? 'not an approved key holder';
    return {
      kind: 'check',
      label: { code: file.name },
      status: file.recipientOnList === 'pass' ? 'pass' : file.recipientOnList === 'fail' ? 'fail' : 'not-checked',
      detail: `recipient ${owner}`,
      hash: file.sha256,
      failure: `${file.name} is addressed to someone who is not an approved key holder.`,
    };
  });
  return {
    ok:
      report.hashCheck === 'pass' &&
      report.examIdCheck === 'pass' &&
      report.coverage.check === 'pass' &&
      report.files.every((file) => file.recipientOnList !== 'fail'),
    items: [
      hashRow,
      verdict('Manifest is for this exam', report.examIdCheck, { failure: 'The list of published files is for a different exam.' }),
      coverage,
      ...files,
    ],
  };
}

function sealedStep(c: Context): Draft {
  const { build, records } = c;
  const signature = buildSignatureItem(records?.token ?? null);
  const manifest = records ? manifestItems(records.manifest) : { items: [notChecked('Storage manifest', 'Not read yet')], ok: false };
  const at = build ? Number(build.postedAt) : null;
  const complete = build !== null && signature.ok && manifest.ok;
  return {
    id: 'sealed',
    label: 'Paper built and sealed',
    complete,
    at,
    round: roundOf(at),
    note: !build
      ? 'The sealed machine builds the paper after the questions lock. No person sees it.'
      : complete
        ? 'One sealed paper, built by the sealed machine and signed by it. Its files match the public record.'
        : "The paper's record is published. Its files and signature have not all been checked yet.",
    items: [
      build
        ? { kind: 'check', label: 'Build', status: 'pass', detail: 'Exists' }
        : notChecked('Build', 'No Build yet'),
      ...(build
        ? ([
            { kind: 'hash', label: 'Paper fingerprint, paperHash', value: build.paperHash },
            { kind: 'hash', label: 'Salted paper fingerprint, saltedPaperHash', value: build.saltedPaperHash },
            { kind: 'hash', label: "Build's storageManifestHash", value: build.storageManifestHash },
            { kind: 'hash', label: 'Signed by instance key', value: build.instancePublicKey },
          ] satisfies Item[])
        : []),
      signature.item,
      ...manifest.items,
    ],
  };
}

/** Until `trusted`, every badge is neutral: a count from an unverified source is hearsay, not evidence. */
function progressItems(progress: ReleaseProgress, trusted: boolean): Item[] {
  return [
    { kind: 'fact', label: 'Holders released', value: `${String(progress.count)} of ${String(progress.required)} needed${trusted ? '' : ' (not verified)'}` },
    ...progress.rows.map(
      (row): Item => ({
        kind: 'tag',
        label: `${row.owner}, ${roleNames[row.role] ?? 'key holder'}`,
        tone: row.released && trusted ? 'ok' : 'neutral',
        tag: row.released ? 'Released' : 'Not released',
      }),
    ),
    ...progress.unknown.map(
      (key): Item =>
        trusted
          ? { ...fail('Released by a key that is not an approved key holder', 'A key that is not on the approved list released a part of the key.'), hash: key }
          : { kind: 'tag', label: 'Released by a key that is not an approved key holder', tone: 'neutral', tag: 'Unverified', hash: key },
    ),
  ];
}

function logItems(result: LogVerdict, signatureLabel: string, signatureAbsent: string): Item[] {
  return [
    verdict('Log is for this exam', result.examId, { failure: 'The release log is for a different exam.' }),
    verdict('entriesHash matches the entries', result.entriesHash, { failure: 'The release log has been changed: its entries do not match its hash.' }),
    verdict(signatureLabel, result.signature, {
      failure: 'The release log is not signed by the key it should be signed by.',
      absent: signatureAbsent,
    }),
    ...(result.error ? [fail('Log error', `The release log could not be checked: ${result.error}`, result.error)] : []),
  ];
}

function publishedLogItems(log: Records['log'] | null): { items: Item[]; verified: ReleaseProgress | null; said: ReleaseProgress | null; complete: boolean } {
  const empty = { verified: null, said: null, complete: false };
  if (!log) return { ...empty, items: [notChecked('Published release log', 'Not read yet')] };
  if (log.kind === 'malformed') {
    return { ...empty, items: [fail('Release log format', `The release log can't be read: ${log.message}`, log.message)] };
  }
  if (log.kind !== 'ready') return { ...empty, items: [sourceGap('Published release log', log)] };
  const { token, progress } = log;
  const trusted = token?.verified === true;
  const failedClaims = token?.claims.filter((claim) => !claim.ok).map((claim) => claim.claim).join(', ') ?? '';
  const tokenProblem = token && !token.signature.ok ? token.signature.error.message : failedClaims;
  return {
    verified: trusted ? progress : null,
    said: progress,
    complete:
      trusted &&
      log.verdict.examId === 'pass' &&
      log.verdict.entriesHash === 'pass' &&
      log.verdict.signature === 'pass' &&
      progress !== null &&
      progress.count >= progress.required,
    items: [
      ...(trusted
        ? []
        : [{ kind: 'text' as const, tone: 'warn' as const, text: 'Unverified. Until that token passes, nothing says which TEE signed this log, so its release list is not evidence.' }]),
      ...logItems(log.verdict, 'Signed by the key the log names', 'Not checked'),
      ...(progress ? progressItems(progress, trusted) : []),
      token
        ? token.verified
          ? { kind: 'check', label: 'release-token.jwt attests the key that signed the log', status: 'pass' }
          : fail(
              'release-token.jwt attests the key that signed the log',
              `The proof behind the release log does not pass: ${tokenProblem}`,
              tokenProblem,
            )
        : notChecked('release-token.jwt attests the key that signed the log', 'Not in storage yet or the exam is not published'),
    ],
  };
}

function liveReleaseItems(c: Context): Item[] {
  const heading: Item = { kind: 'heading', text: 'Live from the sealed machine, optional' };
  if (!c.view.sources.tee) return [heading, { kind: 'text', text: needsTee }];
  const { live } = c;
  if (!live) {
    const message = c.view.live.state === 'error' ? `Could not be read: ${c.view.live.message}` : 'Not read yet';
    return [heading, notChecked('Live release', message)];
  }
  const trusted = live.fresh.ok && live.fresh.value.trusted;
  const stage = live.status.ok ? live.status.value : null;
  const stateItems: Item[] = !stage
    ? [notChecked('Stage', live.status.ok ? 'Not read yet' : `Could not be read: ${live.status.message}`)]
    : [
        { kind: 'fact', label: 'Stage', value: `${stage.stage}${trusted ? '' : ' (not verified)'}` },
        ...(live.progress
          ? progressItems(live.progress, trusted)
          : [
              {
                kind: 'fact' as const,
                label: 'Holders released',
                value: `${String(stage.release.released.length)} of ${String(stage.release.required)} needed${trusted ? '' : ' (not verified)'}`,
              },
            ]),
      ];
  return [
    heading,
    ...(trusted
      ? [{ kind: 'check' as const, label: 'TEE attestation passes, so its answers can be trusted', status: 'pass' as const }]
      : [{ kind: 'text' as const, tone: 'warn' as const, text: 'Unverified. The TEE has not passed attestation, so what it reports here is not evidence. See step 2.' }]),
    ...stateItems,
    ...(live.log
      ? logItems(live.log, "Signed by the live TEE's attested key", 'Not checked, the log is not signed by the attested key')
      : [notChecked('Release log', 'Not available yet')]),
  ];
}

/** Who has released, in the strongest words the evidence allows. */
function releaseLine(c: Context, published: ReleaseProgress | null, said: ReleaseProgress | null): string {
  const trustedLive = c.live?.fresh.ok === true && c.live.fresh.value.trusted ? c.live.progress : null;
  const known = published ?? trustedLive;
  if (known) return `${String(known.count)} of the ${String(known.required)} needed key holders have released.`;
  const unverified = said ?? c.live?.progress ?? null;
  if (unverified) return `${String(unverified.count)} of the ${String(unverified.required)} needed key holders may have released. This is not verified yet.`;
  return 'No release has been verified yet.';
}

function unlockStep(c: Context, sealedOff: boolean): Draft {
  const { exam, build } = c;
  const logs = publishedLogItems(c.records?.log ?? null);
  const unlockAt = exam ? roundTimeSeconds(Number(exam.settings.unlockRound)) : null;
  const countdown: Item[] = exam
    ? [
        {
          kind: 'countdown',
          at: (unlockAt ?? 0) * 1000,
          round: Number(exam.settings.unlockRound),
          label: 'Paper unlocks',
          reached: c.unlockReached ? 'Time seal open' : 'Due, waiting for the public clock',
        },
        c.view.latest.round !== null
          ? { kind: 'fact', label: 'Latest public clock round', value: c.view.latest.round.toLocaleString('en-GB') }
          : notChecked('Latest public clock round', c.view.latest.error ? 'Public clock not reached' : 'Loading'),
        roundRow('Lock', exam.settings.lockRound, c),
        roundRow('Unlock, T minus Δ', exam.settings.unlockRound, c),
        roundRow('End, paper opens', exam.settings.endRound, c),
      ]
    : [];
  const noPaper = c.endReached && build === null;
  const note = logs.complete
    ? releaseLine(c, logs.verified, logs.said)
    : noPaper
      ? 'No paper was sealed, so there is nothing to unlock.'
      : sealedOff
        ? 'The unlock did not happen.'
        : !exam || unlockAt === null
          ? 'Waiting for the exam to be published.'
          : c.unlockReached
            ? `Time seal open. ${releaseLine(c, logs.verified, logs.said)}`
            : `Opens to centres at ${c.when(unlockAt)}. Nothing can open it sooner.`;
  return {
    id: 'unlock',
    label: 'Unlock',
    complete: logs.complete,
    notApplicable: noPaper || sealedOff,
    at: unlockAt,
    round: exam ? Number(exam.settings.unlockRound) : null,
    note,
    items: [
      ...countdown,
      { kind: 'heading', text: 'Published release log' },
      ...logs.items,
      ...liveReleaseItems(c),
      ...(build ? machineFailed(c) : []),
    ],
  };
}

const proofLabels: Record<keyof ProofChecks, { label: string; failure: string }> = {
  paperFile: { label: 'paper.bin is the file the Build hashed (paperHash)', failure: 'The published paper file is not the one the Build committed to.' },
  saltedHash: { label: 'Seed and paper give the Build’s saltedPaperHash', failure: 'The opened paper is not the paper the Build committed to.' },
  examId: { label: 'Paper is for this exam', failure: 'The opened paper is for a different exam.' },
  selectedCount: { label: 'Question count equals the Build’s selected', failure: 'The paper has a different number of questions from the Build.' },
  criteriaCount: { label: 'Build’s selected equals the published criteria’s total', failure: 'The Build chose a different number of questions from the published criteria.' },
  topics: { label: 'Each topic has the question count the criteria ask for', failure: 'A topic in the paper does not have the number of questions the criteria ask for.' },
  criteriaHash: { label: 'Published criteria match the exam’s criteriaHash', failure: 'The published criteria do not match the fingerprint on the public record.' },
};

const proofNames = Object.keys(proofLabels) as (keyof ProofChecks)[];

function proofItems(proof: Extract<ProofRun, { ok: true }>['result']): { items: Item[]; complete: boolean; note: string } {
  switch (proof.state) {
    case 'not-ready':
      return { items: [notChecked('Proof', proof.reason)], complete: false, note: proof.reason };
    case 'waiting':
      return { items: [notChecked('Proof', 'The end round has not arrived.')], complete: false, note: 'The end round has not arrived.' };
    case 'sealed':
      return {
        complete: false,
        note: 'No copy exists, and the paper stays sealed.',
        items: [
          notChecked('Proof', 'No copy exists, and the paper stays sealed'),
          {
            kind: 'text',
            text: `The end round has passed, and storage holds no ${storageNames.keyPriv}. If the unlock never happened, the timelocked copy of K_priv was never published, so nobody can open the paper. If you expected an unlock, check the storage address under "Check against your own RPC".`,
          },
        ],
      };
    case 'failed': {
      const label = proof.step === 'files' ? 'Files' : proof.step === 'timelock' ? 'Timelock' : 'Paper decryption';
      return { complete: false, note: 'The paper did not open.', items: [fail(label, `The paper did not open: ${proof.message}`, proof.message)] };
    }
    case 'opened': {
      const results = proofNames.map((name) =>
        verdict(proofLabels[name].label, proof.checks[name], { failure: proofLabels[name].failure, absent: 'No criteria on the chain' }),
      );
      const passed = proofNames.filter((name) => proof.checks[name] === 'pass').length;
      const complete = passed === proofNames.length && proof.paper !== null && !proof.parseError;
      return {
        complete,
        note: complete ? `The paper is open to everyone. All ${String(passed)} checks passed.` : `The paper opened. ${String(passed)} of ${String(proofNames.length)} checks passed.`,
        items: [
          ...results,
          ...(proof.parseError ? [fail('Paper format', `The opened paper can't be read: ${proof.parseError}`, proof.parseError)] : []),
          {
            kind: 'text',
            text: 'Selection is attested by the TEE, not independently proven, because the question bank stays hidden. The salted hash shows this is the paper the Build committed to, not what a centre showed students.',
          },
          ...(proof.paper ? [] : [notChecked('Paper withheld', 'The paper opened, but it is not shown because it does not match the Build.')]),
        ],
      };
    }
  }
}

function openStep(c: Context): Draft {
  const { exam, build } = c;
  const endRound = exam ? Number(exam.settings.endRound) : null;
  const endAt = endRound === null ? null : roundTimeSeconds(endRound);
  const base = { id: 'open' as const, label: 'Exam ends and paper opens', at: endAt, round: endRound };
  if (!exam || endRound === null || endAt === null) {
    return { ...base, complete: false, note: 'Waiting for the exam to be published.', items: [notChecked('Proof', 'The exam is not published on the chain yet.')] };
  }
  if (!c.endReached) {
    return {
      ...base,
      complete: false,
      note: `Opens to everyone at ${c.when(endAt)}. The public clock does this, not a person.`,
      items: [
        notChecked('Proof', 'Not open yet'),
        {
          kind: 'text',
          text: `The paper opens when the public clock publishes round ${String(endRound)}, at ${utcTime(endAt)}. Nothing here can open it sooner.`,
        },
      ],
    };
  }
  if (build === null) {
    return { ...base, complete: false, notApplicable: true, note: 'No paper was sealed, so there is nothing to open.', items: [notChecked('Proof', 'There is no Build on the chain to compare the paper with.')] };
  }
  const { proof } = c.view;
  if (!c.view.sources.storage) return { ...base, complete: false, note: 'Needs the storage address to open the paper.', items: [notChecked('Proof', needsStorage)] };
  if (!proof) return { ...base, complete: false, note: 'Opening the paper.', items: [notChecked('Proof', 'Opening the paper.')] };
  if (!proof.ok) {
    return { ...base, complete: false, note: 'The paper could not be opened just now. This page will try again.', items: [notChecked('Proof', `Could not be read: ${proof.message}`)] };
  }
  const result = proofItems(proof.result);
  return { ...base, complete: result.complete, notApplicable: proof.result.state === 'sealed', note: result.note, items: result.items };
}

const label = (item: CheckItem) => (typeof item.label === 'string' ? item.label : item.label.code);

/** The rows that failed: the specific ones first, and a summary only if nothing else explains it. */
function failuresOf(items: readonly Item[]): string[] {
  const failed = items.filter((item): item is CheckItem => item.kind === 'check' && item.status === 'fail');
  const loud = failed.filter((item) => !item.quiet);
  const chosen = loud.length > 0 ? loud : failed;
  return [...new Set(chosen.map((item) => item.failure ?? `${label(item)} failed.`))];
}

/** Sets each draft's state: its failures first, then done, then the first step anyone is waiting on. */
function settle(drafts: readonly Draft[]): CustodyStep[] {
  let holding = false;
  return drafts.map((draft, index) => {
    const failures = failuresOf(draft.items);
    let state: StepState;
    if (failures.length > 0) state = 'failed';
    else if (draft.complete) state = 'done';
    else if (draft.notApplicable) state = 'not-applicable';
    else if (draft.blocks !== false && !holding) {
      state = 'current';
      holding = true;
    } else state = 'waiting';
    return {
      id: draft.id,
      number: index + 1,
      label: draft.label,
      state,
      // A record with no usable time simply shows none.
      at: Number.isFinite(draft.at) ? (draft.at ?? null) : null,
      round: draft.round ?? null,
      note: draft.note,
      items: draft.items,
      failures,
    };
  });
}

const BEFORE_SEAL: readonly StepId[] = ['published', 'attested', 'people', 'locked', 'sealed'];

function sealOf(c: Context, steps: readonly CustodyStep[]): SealState | null {
  const { proof } = c.view;
  const opened = proof?.ok === true ? proof.result.state : null;
  if (opened === 'opened') return 'open';
  if (opened === 'failed') return 'opening';
  // A seal says the paper was built and sealed as promised, so all of that has to have been shown.
  if (!steps.filter((step) => BEFORE_SEAL.includes(step.id)).every((step) => step.state === 'done')) return null;
  if (opened === 'sealed') return 'sealed';
  return c.unlockReached ? 'opening' : 'sealed';
}

interface Words {
  headline: string;
  next: string;
}

/** Where things stand when no exam can be shown. Null once there is one. */
function noExamWords(view: View): Words | null {
  const again = 'This page keeps trying by itself. You can also read the record through your own connection below.';
  if (view.invalidLink) return { headline: 'This link does not name an exam.', next: 'Check the link with your exam board, or enter the exam ID below.' };
  if (!view.examId) return { headline: 'Choose an exam to check.', next: 'Enter the exam ID below, or open the link your exam board shared.' };
  if (!view.sources.chain) return { headline: 'Not connected to the public record.', next: 'Add a Sepolia RPC URL and the ExamRegistry address below. Nothing has been checked yet.' };
  if (view.records.state === 'loading') return { headline: 'Reading the public record.', next: 'The checks run in this browser and take a few seconds.' };
  if (view.records.state === 'error') return { headline: 'The public record could not be read.', next: again };
  return null;
}

function examWords(c: Context, steps: readonly CustodyStep[], seal: SealState | null, proofState: string | null): Words {
  const { exam, build, chain } = c;
  const auto = 'This page updates by itself.';
  if (!exam) return { headline: 'This exam is not on the public record.', next: `Once the exam board publishes it, it will appear here. ${auto}` };
  const unlockAt = roundTimeSeconds(Number(exam.settings.unlockRound));
  const lockAt = roundTimeSeconds(Number(exam.settings.lockRound));
  const endAt = roundTimeSeconds(Number(exam.settings.endRound));
  const state = (id: StepId) => steps.find((step) => step.id === id)?.state;
  if (proofState === 'opened') {
    return state('open') === 'done'
      ? { headline: 'Paper open. Anyone can read it and check it.', next: 'Nothing more happens. Anyone can repeat these checks at any time.' }
      : { headline: 'The paper opened, but it did not pass every check.', next: 'Contact your exam board and quote the failed checks.' };
  }
  if (c.endReached) {
    if (!build) return { headline: 'The exam ended with no paper published.', next: 'Nothing more happens. Contact your exam board if you expected a paper.' };
    if (proofState === 'sealed') return { headline: 'The paper stays sealed. The unlock never happened.', next: 'Nobody can open this paper now. Contact your exam board if you expected an unlock.' };
    if (proofState === 'failed') return { headline: 'The paper did not open.', next: 'Contact your exam board and quote the failed check.' };
    return { headline: 'Exam over. Opening the paper.', next: 'The public clock has opened the paper. This page is checking it now.' };
  }
  if (!chain?.list) return { headline: 'Setting up. The approved list is not published yet.', next: `The exam board publishes the list of approved people next. ${auto}` };
  if (!build) {
    return c.lockReached
      ? { headline: 'Lock time has passed. The paper is not published yet.', next: `The sealed machine builds the paper next, and no person sees it. ${auto}` }
      : { headline: `Questions are coming in. They lock at ${c.when(lockAt)}.`, next: 'After that the sealed machine builds the paper, and no person sees it.' };
  }
  if (BEFORE_SEAL.some((id) => state(id) === 'failed')) {
    return { headline: 'Paper published, but it failed its checks.', next: 'Contact your exam board and quote the failed check.' };
  }
  if (seal === null) return { headline: 'Paper published. Its checks are not finished.', next: `The checks finish once the published files can be read. ${auto}` };
  if (!c.unlockReached) {
    return { headline: `Paper sealed. Opens to centres at ${c.when(unlockAt)}.`, next: 'At that time the time seal opens, and key holders release their parts of the key.' };
  }
  if (state('unlock') === 'done') {
    return { headline: `Key holders have released. The paper opens to everyone at ${c.when(endAt)}.`, next: 'After the exam the public clock opens the paper, and this page checks it.' };
  }
  const last = steps.find((step) => step.id === 'unlock');
  return { headline: `Opening to centres. ${last?.note.replace('Time seal open. ', '') ?? ''}`.trim(), next: 'Once enough key holders have released, centres can open the paper.' };
}

function verdictLine(c: Context, steps: readonly CustodyStep[], failures: readonly Failure[]): string {
  if (failures.length > 0) {
    return failures.length === 1 ? 'One check failed. Do not rely on this exam until it is explained.' : `${String(failures.length)} checks failed. Do not rely on this exam until they are explained.`;
  }
  if (!c.exam) return 'Nothing has been checked yet.';
  const done = steps.filter((step) => step.state === 'done').length;
  if (done === steps.length) return 'Every step has been checked. Nothing failed.';
  const gaps = [c.records?.token, c.records?.manifest, c.records?.log].some((source) => source?.kind === 'unavailable');
  if (gaps) return 'Nothing has failed so far, but some public files could not be read.';
  return `This exam is on track. Nothing has failed so far. ${String(done)} of ${String(steps.length)} steps are confirmed.`;
}

/** The whole chain of custody, as it stands at this moment. */
export function custody(view: View): Custody {
  const records = view.records.state === 'ready' ? view.records.value : null;
  const chain = records?.chain ?? null;
  const exam = chain?.exam ?? null;
  const build = chain?.build ?? null;
  const live = view.live.state === 'ready' && !('kind' in view.live.value) ? view.live.value : null;
  const reached = (round: bigint | undefined) => round !== undefined && roundReached(Number(round), view.latest.round, view.now);

  const c: Context = {
    view,
    chain,
    exam,
    build,
    checks: chain ? chainChecks(view.examId, chain) : null,
    records,
    live,
    lockReached: reached(exam?.settings.lockRound),
    unlockReached: reached(exam?.settings.unlockRound),
    endReached: reached(exam?.settings.endRound),
    when: (seconds) => `${clockTime(seconds, view.now, view.timeZone)}, ${inWords(seconds - view.now)}`,
  };

  const proof = view.proof?.ok === true ? view.proof.result : null;
  const logReady = records?.log.kind === 'ready';
  // Nothing in storage at the end round: no copy of the key exists, so the unlock never happened.
  const unlockOff = proof?.state === 'sealed' && !logReady;
  const steps = settle([
    publishedStep(c),
    attestedStep(c),
    peopleStep(c),
    lockedStep(c),
    sealedStep(c),
    unlockStep(c, unlockOff),
    openStep(c),
  ]);

  const failures = steps.flatMap((step) => step.failures.map((message) => ({ step: step.number, label: step.label, message })));
  const seal = sealOf(c, steps);
  const paper = proof?.state === 'opened' ? proof.paper : null;
  const words = noExamWords(view) ?? examWords(c, steps, seal, proof?.state ?? null);
  return {
    steps,
    failures,
    seal,
    noSeal: build ? 'Not confirmed' : 'Not sealed yet',
    headline: words.headline,
    verdict: verdictLine(c, steps, failures),
    next: failures.length > 0 ? 'Contact your exam board and quote the failed check. This page keeps checking by itself.' : words.next,
    paper,
    withheld: proof?.state === 'opened' && proof.paper === null,
  };
}
