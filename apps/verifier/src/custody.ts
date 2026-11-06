import { arkiv } from '@paperseal/arkiv';
import type { ClaimCheck } from '@paperseal/attestation';
import type { ExamNameCheck, ExamNameResult, PasskeyNameResult, ResolvedExamName } from '@paperseal/chain';
import {
  chain as chainSpec,
  decodeApprovedList,
  decodeCriteria,
  fromHex,
  ownerEnsName,
  pick,
  requireHardwareAttestation,
  roles,
  roundAtSeconds,
  roundTimeSeconds,
  scheduleBoundsProblem,
  storageNames,
  toHex,
  type ApprovedListEntry,
  type Hex,
  type Paper,
  type WebConfig,
} from '@paperseal/protocol';
import type { CheckStatus, SealState, StepState, Tone } from '@paperseal/ui';
import {
  chainChecks,
  computedListHash,
  releaseTokenName,
  sameHex,
  type BackupFile,
  type BackupUse,
  type BucketGap,
  type Build,
  type ChainData,
  type ChainProblem,
  type CheckResult,
  type Exam,
  type LogVerdict,
  type ProofChecks,
  type ReleaseFileReport,
  type ReleaseFilesReport,
  type ReleaseProgress,
} from '@paperseal/verify';

import { roundStatus, type LatestRound } from './live';
import {
  ARKIV_STALE_AFTER_SECONDS,
  isValidLog,
  roundReached,
  type ArkivIgnored,
  type ArkivReport,
  type LiveReport,
  type ManifestResult,
  type Neutral,
  type ProofRun,
  type Records,
  type Sourced,
} from './load';
import type { Polled } from './poll';
import { runtimeConfig, viteEnv, type ViteEnv } from './runtime-config';
import type { SourcedWriter, WriterOrigin } from './settings';
import { defaultRepository, repositoryPattern } from './repository';

export { defaultRepository };

/*
 * Turns everything the checks found into the chain of custody. It decides what each step's state
 * is and says so in words, and it runs no check of its own: every verdict comes from checks.ts,
 * attest.ts, commitments.ts, unlock.ts or proof.ts.
 *
 * A step's evidence is data, not markup, so its state can't disagree with it. Any Fail row fails
 * its step and reaches the top of the page, and a step can only be done when `complete` says so.
 */


/**
 * The repository the code and build links point at: VITE_RELEASES_REPO, then `config.json`'s
 * `repository`, then the default. A fork sets it to its own `owner/name`, the same variable the
 * board app reads its releases from. A bad `VITE_` value is an error. A bad `config.json` value
 * never arrives, because the file's invalid fields are dropped.
 */
export function repository(env: ViteEnv = viteEnv, config: WebConfig = runtimeConfig()): string {
  const given = pick(env.VITE_RELEASES_REPO, config.repository, defaultRepository);
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

export type StepId = 'name' | 'published' | 'attested' | 'people' | 'locked' | 'sealed' | 'unlock' | 'open';

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
  /** A quiet line under the note. */
  aside?: string;
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
  /** Plain sentences for the main view. Worth asking about, and never a failed check. */
  warnings: string[];
  /** Null until the code has established a seal state. Never a stand-in for a check not run. */
  seal: SealState | null;
  /** Shown under the headline with the seal: what an independent check reports for a test exam. */
  testNetwork: string | null;
  /** Why the seal is not shown. */
  noSeal: string;
  headline: string;
  verdict: string;
  next: string;
  /** Present only when the proof opened the paper and it matches the Build. */
  paper: Paper | null;
  withheld: boolean;
  /** Where the release count shown came from, or null with none verified. */
  progressSource: ProgressSource | null;
}

/** A `#/name/` route: the name as written, what reading it found, and the locators in use. */
export interface NameView {
  name: string;
  result: Polled<ExamNameResult>;
  /** What this view reads from: the name's records, or the viewer's own values where it sets none. */
  used: { teeUrl: string; storageUrl: string; bucket: string };
  /** The registry this page is set to read, if any, to compare with the name's. */
  configuredRegistry: string;
}

export interface View {
  examId: Hex | null;
  /** The URL named something that is not an exam ID. */
  invalidLink: boolean;
  /** Only on a name route. The exam ID and registry then come from the name, once it passes. */
  name?: NameView;
  /**
   * What each listed party's ENS name says about its security key, by passkey public key. A label and a
   * proof of who holds a key, never a check the exam depends on. Absent where names are not read.
   */
  partyNames?: Polled<Record<string, PartyName>>;
  sources: { chain: boolean; storage: boolean; tee: boolean; arkiv: boolean };
  records: Polled<Records>;
  live: Polled<LiveReport | Neutral>;
  /** The Arkiv mirror of the release evidence. Off until there are writers to trust. */
  arkiv: Polled<ArkivReport | Neutral>;
  /** The writers read from Arkiv, and where each came from. Left out, the report's list is shown untagged. */
  arkivWriters?: readonly SourcedWriter[];
  /** Entries in the exam name's writer record that are not addresses, so are not read. */
  arkivWritersIgnored?: readonly string[];
  latest: LatestRound;
  /** Unix seconds. */
  now: number;
  proof: ProofRun | null;
  /** For tests. */
  timeZone?: string;
}

const needsStorage = 'Add where the public files are kept under "Check it yourself" at the foot of the page.';
const needsTee = 'Add the live machine address under "Check it yourself" at the foot of the page. Every other check works without it.';
const needsArkiv = 'Add who may write the copy on Arkiv under "Check it yourself" at the foot of the page. Every other check works without it.';

export const roleNames: Record<number, string> = {
  1: 'Setter',
  2: 'Key holder',
  3: 'Centre holding part of the key',
  4: 'Centre that gets the key when the paper unlocks',
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

/** Settings are not bounded on-chain, so a time can be past what a date can hold. It must still render, and fail its check. */
const tooFar = (seconds: number) => !(Math.abs(seconds) * 1000 <= 8.64e15);
const noDate = 'A date too far away to show';

/** `Sat 7 Nov, 21:30`, in the viewer's own time zone. */
export function dayTime(seconds: number, timeZone?: string): string {
  if (tooFar(seconds)) return noDate;
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...inZone(timeZone) });
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...inZone(timeZone) });
  return `${day.format(seconds * 1000).replace(',', '')}, ${time.format(seconds * 1000)}`;
}

/** `21:30` today, and `Sat 7 Nov, 21:30` on any other day. */
export function clockTime(seconds: number, now: number, timeZone?: string): string {
  if (tooFar(seconds)) return noDate;
  const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', ...inZone(timeZone) });
  const full = dayTime(seconds, timeZone);
  return date.format(seconds * 1000) === date.format(now * 1000) ? full.slice(full.indexOf(', ') + 2) : full;
}

/** The exact moment, in UTC, for evidence someone may compare elsewhere. */
export const utcTime = (seconds: number) => (tooFar(seconds) ? noDate : `${new Date(seconds * 1000).toISOString().replace('.000Z', '')} UTC`);

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
    ? fail(label, `${label} on the public record does not match its fingerprint.`, problem.message)
    : notChecked(label, `Could not be read: ${problem.message}`);
}

function claimRow(check: ClaimCheck): Item {
  if (check.ok) return { kind: 'check', label: { code: check.claim }, status: 'pass', detail: short(check.actual) };
  const detail = `${short(check.actual)}, expected ${short(check.expected)}${check.note ? ` (${check.note})` : ''}`;
  return fail({ code: check.claim }, 'The proof that Paper Seal runs the published code does not match what was published.', detail);
}

const gapWords: Record<BucketGap, string> = {
  missing: 'The public files do not have it.',
  unreadable: 'The public files could not be read.',
  mismatch: 'The copy in the public files does not match.',
};

/**
 * Which of this step's files came from the Swarm backup, and where, as spec/arkiv.md "Backups",
 * "Reading", rule 4 says. A backup that could not be read is only "not read", never a failure.
 */
function backupItems(use: BackupUse | undefined, names: readonly string[]): Item[] {
  if (!use) return [];
  const wanted = new Set(names);
  const served = use.served.filter((file) => wanted.has(file.name));
  const notRead = use.missed.filter((miss) => wanted.has(miss.name) && miss.kind === 'not-read');
  const rejected = use.rejected.filter((copy) => wanted.has(copy.name));
  if (served.length === 0 && notRead.length === 0 && rejected.length === 0) return [];
  const collections = new Map<string, BackupFile>();
  for (const file of served) if (!collections.has(file.swarmRef)) collections.set(file.swarmRef, file);
  const ignored = [
    use.ignored.collections > 0 ? `${plural(use.ignored.collections, 'backup')} whose file list does not match the public record` : null,
    use.ignored.files > 0 ? `${plural(use.ignored.files, 'file')} that did not match the file list` : null,
  ].filter((part) => part !== null);
  return [
    { kind: 'heading', text: 'Backup on Swarm' },
    ...served.flatMap((file): Item[] => [
      file.inManifest
        ? {
            kind: 'check',
            label: { code: file.name },
            status: 'pass',
            detail: `From the Swarm backup, checked against the exam's on-chain record. ${gapWords[file.bucket]}`,
          }
        : {
            kind: 'fact',
            label: { code: file.name },
            value: `From the Swarm backup. ${gapWords[file.bucket]} It passed the checks in this step before it was used, as a copy in the public files must.`,
          },
      { kind: 'link', href: file.url, text: `Open ${file.name} on Swarm` },
    ]),
    ...[...collections.values()].flatMap((file): Item[] => [
      { kind: 'hash', label: 'Swarm reference', value: file.swarmRef },
      { kind: 'hash', label: 'Arkiv entity key of the backup row', value: file.entityKey },
      { kind: 'link', href: `${arkiv.network.explorer}/entity/${file.entityKey}`, text: 'Open the backup row in the Arkiv explorer' },
    ]),
    ...notRead.map((miss) => notChecked({ code: miss.name }, `Not read from the Swarm backup. ${miss.reason}`)),
    // A backup copy that failed is ignored, as a bad copy in the public files would be. Never a failure.
    ...rejected.map(
      (copy): Item => ({
        kind: 'fact',
        label: { code: copy.name },
        value: `A copy in the Swarm backup ${copy.swarmRef} did not pass the checks in this step, so it was not used. ${copy.reason}`,
      }),
    ),
    ...(ignored.length > 0 ? [{ kind: 'fact' as const, label: 'Backups ignored', value: ignored.join(', ') }] : []),
  ];
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
  /** A failure here leaves every later step waiting. */
  stops?: boolean;
  aside?: string;
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
  arkiv: ArkivReport | null;
  lockReached: boolean;
  unlockReached: boolean;
  endReached: boolean;
  /** `Fri 21:30, in 14 minutes`. */
  when: (seconds: number) => string;
}

/** A step's number as shown: a name route puts the Name step first, so the others move down one. */
const stepNumber = (c: Context, withoutName: number) => withoutName + (c.view.name ? 1 : 0);

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
    { kind: 'fact', label: 'Exam start', value: utcTime(Number(s.examStart)) },
    { kind: 'fact', label: 'Paper released to centres this long before the exam', value: `${String(s.delta)} s` },
    { kind: 'fact', label: `Lock round ${String(s.lockRound)}`, value: utcTime(roundTimeSeconds(Number(s.lockRound))) },
    { kind: 'fact', label: `Unlock round ${String(s.unlockRound)}`, value: utcTime(roundTimeSeconds(Number(s.unlockRound))) },
    { kind: 'fact', label: `End round ${String(s.endRound)}`, value: utcTime(roundTimeSeconds(Number(s.endRound))) },
    { kind: 'hash', label: 'Criteria hash', value: s.criteriaHash },
    { kind: 'fact', label: 'Public record address Paper Seal uses', value: s.rpcHost },
    { kind: 'hash', label: 'Software version, the commit it was built from', value: exam.commitHash },
    { kind: 'hash', label: 'Software image', value: exam.imageDigest },
    { kind: 'link', href: `https://github.com/${REPOSITORY}/commit/${exam.commitHash.slice(2)}`, text: 'Read this version of the code' },
  ];
}

/** The short titles of docs/ens-setup.md, one per check a name can fail. */
const nameTitles: Record<ExamNameCheck, string> = {
  name: 'Not a valid name',
  registry: 'No exam record',
  primaryName: 'Not the board’s name',
  forward: 'Not confirmed by the board',
  unreadable: "Can't read the name",
};

/** What each failure means to someone who is not technical. The exact reason stays in the evidence. */
const nameFailures: Record<ExamNameCheck, string> = {
  name: 'Check how the name is spelled.',
  registry: 'This name does not lead to an exam on the public record.',
  primaryName: 'This name does not belong to the exam board behind that record.',
  forward: 'The exam board behind that record does not confirm this name.',
  unreadable: 'The name could not be read.',
};

export const sepoliaName = 'On Sepolia, a test network, anyone can register a similar name, so this check is only a demo.';

/**
 * The note under the headline while the seal shows, so a whole seal never reads as a full
 * verification: until exams carry a production mode, the independent checker reports `partial`
 * (spec/agent-verification.md, "Report"). A broken seal has no note, because that check reports a
 * failure, and the failure banner already says so.
 */
export function testNetworkNote(seal: SealState | null): string | null {
  if (seal === null || seal === 'broken') return null;
  const network = chainSpec.name.charAt(0).toUpperCase() + chainSpec.name.slice(1);
  return `Test exam on ${network}. An independent check reports it as partial, not verified, until exams carry a production mode.`;
}

const otherRegistry =
  'This name leads to a different exam record from the one this page is set up to read. Ask your exam board if this is the right exam before you rely on it.';

/** The registry a name leads to, when this page was set up with a different one. */
function differentRegistry(named: NameView): string | null {
  const read = named.result.state === 'ready' ? named.result.value : null;
  const registry = read?.ok ? read.value.registry : read?.partial.registry;
  if (!registry || !named.configuredRegistry) return null;
  return registry.toLowerCase() === named.configuredRegistry.toLowerCase() ? null : registry;
}

function otherRegistryRows(named: NameView): Item[] {
  if (differentRegistry(named) === null) return [];
  return [
    { kind: 'text', tone: 'warn', text: otherRegistry },
    { kind: 'hash', label: 'Exam record this page is set up to read', value: named.configuredRegistry },
  ];
}

/** Where one locator came from: the name's record, or the viewer's own value where it sets none. */
function located(label: string, record: string | null, used: string, fallback: string): Item {
  return {
    kind: 'tag',
    label,
    tone: 'neutral',
    tag: record !== null ? 'From the name' : fallback,
    value: used || 'Not set',
  };
}

/** What a failed read had already found, so a viewer can see where it went wrong. */
function partialRows(partial: Partial<ResolvedExamName>): Item[] {
  return [
    ...(partial.examId ? [{ kind: 'hash' as const, label: 'Exam ID, the labelhash of the exam name', value: partial.examId }] : []),
    ...(partial.registry ? [{ kind: 'hash' as const, label: 'Address record', value: partial.registry }] : []),
    ...(partial.board ? [{ kind: 'hash' as const, label: 'Board, from the registry', value: partial.board }] : []),
  ];
}

function nameStep(named: NameView): Draft {
  const base = { id: 'name' as const, label: 'Name', stops: true, complete: false };
  const unreadable = (message: string): Draft => ({
    ...base,
    aside: sepoliaName,
    note: `${nameTitles.unreadable}. This page will try again.`,
    items: [notChecked(nameTitles.unreadable, message)],
  });
  const { result } = named;
  if (result.state === 'off') {
    return {
      ...base,
      aside: sepoliaName,
      note: 'Add where to read the public record under "Check it yourself" to check this name.',
      items: [notChecked('Name', 'Needs a Sepolia RPC URL, which you can add under "Check it yourself".')],
    };
  }
  if (result.state === 'loading') {
    return { ...base, aside: sepoliaName, note: `Checking ${named.name}.`, items: [notChecked('Name', 'Reading')] };
  }
  if (result.state === 'error') return unreadable(`Could not be read: ${result.message}`);
  const read = result.value;
  if (!read.ok) {
    if (read.failed === 'unreadable') return unreadable(`Could not be read: ${read.reason}`);
    const title = nameTitles[read.failed];
    return {
      ...base,
      aside: sepoliaName,
      note: title,
      items: [
        { kind: 'fact', label: 'Name', value: named.name },
        fail(title, `${title}. ${nameFailures[read.failed]}`, read.reason),
        ...partialRows(read.partial),
        ...otherRegistryRows(named),
      ],
    };
  }
  const value = read.value;
  const { used } = named;
  return {
    ...base,
    complete: true,
    aside: sepoliaName,
    note: `${value.name} belongs to the exam board behind this record.`,
    items: [
      { kind: 'check', label: 'Exam name, a valid ENS label', status: 'pass', detail: value.label },
      { kind: 'hash', label: 'Exam ID, the labelhash of the exam name', value: value.examId },
      { kind: 'check', label: 'Address record runs the ExamRegistry code for this board', status: 'pass', hash: value.registry },
      ...otherRegistryRows(named),
      { kind: 'hash', label: 'Board, from the registry', value: value.board },
      { kind: 'check', label: "Board's primary name", status: 'pass', detail: value.parent },
      { kind: 'check', label: `${value.parent} points back to the board, so verified both ways`, status: 'pass' },
      { kind: 'heading', text: 'Where to look' },
      located('TEE URL', value.teeUrl, used.teeUrl, 'From your settings'),
      located('Storage URL', value.storageUrl, used.storageUrl, 'From your settings'),
      located('Storage bucket', value.bucket, used.bucket, 'Built into this page'),
      {
        kind: 'text',
        text: 'These records only say where to look. A wrong value makes the later checks fail, it can’t make them pass. Where the name sets none, this page uses your settings under "Check it yourself".',
      },
    ],
  };
}

/** A step after a name that has not passed: nothing it would check has been read. */
function held(draft: Draft): Draft {
  return {
    id: draft.id,
    label: draft.label,
    complete: false,
    note: 'Waits for the exam name to pass.',
    items: [notChecked(draft.label, 'Not checked until the exam name in step 1 passes')],
  };
}

const registryCodeLabel = 'The exam record runs the published ExamRegistry code';

/** The check that the address really is ExamRegistry, and the board its code holds. */
function registryCodeItems(c: Context): Item[] {
  const code = c.chain?.registryCode;
  if (!code) return [notChecked(registryCodeLabel, 'Not read yet')];
  if (code.state === 'match') {
    return [
      { kind: 'check', label: registryCodeLabel, status: 'pass' },
      { kind: 'hash', label: 'Exam board, the only account that can write here', value: code.board },
    ];
  }
  return code.state === 'none'
    ? [fail(registryCodeLabel, 'There is no exam record at this address. Ask your exam board for the right address.', 'No code at this address')]
    : [fail(registryCodeLabel, 'This address is not a Paper Seal exam record, so nothing it says can be trusted. Ask your exam board for the right address.', 'The code here differs from spec/registry.json')];
}

const boundFailures = {
  delta_too_long: 'The paper reaches centres too long before the exam. Paper Seal does not allow a gap this long.',
  end_too_far: 'This exam ends too long after it starts, so the paper may never open to everyone.',
};

function boundsItem(exam: Exam): Item {
  const problem = scheduleBoundsProblem(exam.settings);
  return verdict('Exam times are within the allowed limits', problem === null, { failure: problem ? boundFailures[problem] : '' });
}

function publishedStep(c: Context): Draft {
  const { exam } = c;
  const seconds = exam ? Number(exam.createdAt) : null;
  const code = c.chain?.registryCode;
  const wrongAddress = code !== undefined && code.state !== 'match';
  return {
    id: 'published',
    label: 'Exam published',
    complete: exam !== null,
    stops: wrongAddress,
    at: seconds,
    round: roundOf(seconds),
    ...(code?.state === 'match' ? { aside: `Only the exam board account ${code.board} can write this record.` } : {}),
    note: wrongAddress
      ? 'This page is not reading a Paper Seal exam record.'
      : exam
        ? "The exam's rules and the exact version of the sealed machine's code are on the public record."
        : 'The exam board has not published this exam.',
    items: [
      ...registryCodeItems(c),
      ...(exam
        ? [{ kind: 'check' as const, label: 'Exam published', status: 'pass' as const, detail: 'Published' }, boundsItem(exam), ...settingsItems(exam, c.view.examId)]
        : wrongAddress
          ? []
          : [notChecked('Exam published', 'Not published')]),
    ],
  };
}

function publishedTokenItems(c: Context): Item[] {
  const token = c.records?.token ?? null;
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
        : { quiet: recordFailed, failure: `The paper is not signed by the same machine that proved it runs the published code. See step ${String(stepNumber(c, 5))}.` }),
    },
    result.signature.ok
      ? { kind: 'check', label: "Token signature, up to Google's root", status: 'pass' }
      : fail(
          "Token signature, up to Google's root",
          'The proof that Paper Seal runs the published code could not be traced back to Google.',
          result.signature.error.message,
        ),
    ...result.claims.map(claimRow),
    { kind: 'hash', label: 'Instance key', value: build.instancePublicKey },
  ];
}

/** Whether the live machine has shown it is running this exam. It decides no check either way. */
const liveTrusted = (live: LiveReport | null) => live?.fresh.ok === true && live.fresh.value.trusted;

/**
 * A plain line on what the live machine is doing now. Checks are judged from what was recorded while
 * the exam ran, so a later machine, a stopped one or one serving another exam changes nothing here.
 */
function liveNote(c: Context): Item[] {
  if (!c.live?.otherExam) return [];
  return [{ kind: 'text', text: 'The live machine is serving another exam now. That does not affect this exam, which is checked from what was recorded while it ran.' }];
}

/** How the keys in the records relate. Each key must have its own recorded proof, so a different key is not a failure. */
function recordedKeyItems(c: Context): Item[] {
  const { build } = c;
  const log = c.records?.log;
  if (!build || log?.kind !== 'ready' || !isValidLog(log.verdict, log.token)) return [];
  const same = sameHex(build.instancePublicKey, log.signer);
  return [
    { kind: 'heading', text: 'Keys in the records' },
    { kind: 'hash', label: 'Key that signed the Build', value: build.instancePublicKey },
    { kind: 'hash', label: 'Key that signed the release log', value: log.signer },
    {
      kind: 'fact',
      label: 'Build and release',
      value: same
        ? 'The same key signed both, and a published proof attests it.'
        : 'Two machines did this work. Each key has its own published proof, and both passed.',
    },
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
  'Demo mode. Paper Seal does not check where security keys come from, so a simulated key could be registered as a key holder, setter or centre.';

function attestedStep(c: Context): Draft {
  const { exam, build } = c;
  const token = c.records?.token ?? null;
  const published = token?.kind === 'ready' ? token : null;
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
        ? { text: 'Every registered security key is checked to come from approved hardware.' }
        : { text: demoWarning, tone: 'warn' as const }),
    },
    { kind: 'text', text: "This is the value in spec/constants.json when this verifier was built. The sealed machine's own value is part of its attested image." },
    { kind: 'heading', text: 'How the public record is read' },
    { kind: 'tag', label: { code: 'chain.readBlock' }, tone: chainSpec.readBlock === 'finalized' ? 'ok' : 'warn', tag: chainSpec.readBlock },
    {
      kind: 'text',
      ...(chainSpec.readBlock === 'finalized'
        ? { text: 'Paper Seal only reads entries that can no longer change.' }
        : { text: 'In this demo, Paper Seal reads the newest entries, which can still change. A real exam must read only entries that can no longer change.', tone: 'warn' as const }),
    },
  ];
  const complete = published?.verdict.verified === true;
  const note = published?.verdict.verified
    ? 'A proof signed by Google says Paper Seal runs the published code.'
    : build
      ? 'The lasting proof has not been checked yet.'
      : 'Not recorded yet. The proof is published together with the paper.';
  const at = published?.issuedAt ?? null;
  return {
    id: 'attested',
    label: 'Paper Seal runs the published code',
    complete,
    blocks: build !== null,
    at,
    round: roundOf(at),
    note,
    items: [
      { kind: 'heading', text: 'Published proof' },
      ...publishedTokenItems(c),
      ...backupItems(c.records?.backup, [storageNames.token]),
      ...recordedKeyItems(c),
      ...liveNote(c),
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
  const parties = neutrals === 1 ? '1 key holder' : `${String(neutrals)} key holders`;
  return `${people} approved: ${plural(setters, 'setter')}, ${parties} and ${plural(centres, 'centre')}.`;
}

const ensNote =
  'A name marked "Name confirmed" had a record naming this security key when this exam\'s list was posted, set by whoever controlled that name. A name can be given a new key later, so that is the time that counts. It is not something the exam depends on, so a name that is not confirmed never fails a check.';

/** What a party name's check says, with `changedSince` when today's record no longer matches it. */
export type PartyName = PasskeyNameResult & { changedSince?: boolean };

/** Whether the check never got an answer. That is neither a match nor a wrong key. */
export const nameUnchecked = (result: PartyName | undefined) =>
  result === undefined || result.state === 'refused' || result.state === 'unreadable' || result.state === 'invalid';

/** What a name's record said when the list was posted, in plain words. `subject` is the name, or "this name". */
export function nameWords(result: PartyName | undefined, subject: string): string {
  if (nameUnchecked(result)) return `The record on ${subject} from when this exam's list was posted could not be read here. This page tries again.`;
  if (result?.changedSince) return `The record on ${subject} has changed since this exam's list was posted. It matched then, and that is what counts.`;
  return result?.state === 'mismatch'
    ? `When this exam's list was posted, the record on ${subject} named a different security key.`
    : `When this exam's list was posted, ${subject} had no record for this security key.`;
}

/** The name above `name`, whose controller vouches for it. Null for a name that sits directly under a top-level domain, which its holder controls. */
function directoryOf(name: string): string | null {
  const parent = name.slice(name.indexOf('.') + 1);
  return parent.includes('.') ? parent : null;
}

/** Says who vouches for the listed names. Whoever controls a parent decides which key each name under it holds. */
export function vouchNote(names: readonly string[]): string {
  const owners = [...new Set(names.flatMap((name) => directoryOf(name) ?? []))];
  if (owners.length === 0) return ensNote;
  return `${ensNote} Whoever controls ${owners.join(' and ')} vouches for the names under it: they decide which key each one holds, and can change it publicly. That says nothing about whether a party is independent of them.`;
}

/** One party whose `owner` is an ENS name. Rows are labels and proofs, never checks, so none of them can fail the step. */
function ensRows(entry: ApprovedListEntry, name: string, names: View['partyNames']): Item[] {
  const label = roleNames[entry.role] ?? `Unknown role ${String(entry.role)}`;
  const result = names?.state === 'ready' ? names.value[toHex(entry.passkeyPublicKey)] : undefined;
  if (result?.state === 'confirmed') {
    return [
      { kind: 'tag', label, value: name, tone: 'ok', tag: 'Name confirmed' },
      ...(result.changedSince ? [{ kind: 'text', text: nameWords(result, name) } as const] : []),
    ];
  }
  const holdsKey = entry.role === roles.neutral;
  const pending = result === undefined && (names === undefined || names.state === 'off' || names.state === 'loading');
  if (pending) {
    const off = names === undefined || names.state === 'off';
    return [
      { kind: 'tag', label, value: name, tone: 'neutral', tag: off ? 'Not checked' : 'Reading' },
      ...(off ? [{ kind: 'text', text: `${name} was not read. Add where to read the public record under "Check it yourself".` } as const] : []),
    ];
  }
  const why = nameWords(result, name);
  if (nameUnchecked(result)) {
    return [
      { kind: 'tag', label, value: name, tone: 'neutral', tag: 'Could not be checked' },
      { kind: 'text', text: why },
    ];
  }
  return [
    { kind: 'tag', label, value: name, tone: holdsKey ? 'warn' : 'neutral', tag: holdsKey ? 'Not confirmed' : 'Label only' },
    { kind: 'text', text: holdsKey ? why : `${why} ${name} is a label${directoryOf(name) ? `, and whoever controls ${directoryOf(name) ?? ''} vouches for it` : ''}. It does not show that the centre is independent.` },
  ];
}

function entryRows(bytes: Uint8Array, names?: View['partyNames']): { items: Item[]; entries: ApprovedListEntry[] | null } {
  try {
    const entries = decodeApprovedList(bytes);
    const named = entries.flatMap((entry) => (entry.role === roles.setter ? [] : (ownerEnsName(entry.owner) ?? [])));
    return {
      entries,
      items: [
        ...entries.flatMap((entry): Item[] => {
          if (entry.role === roles.setter) return [{ kind: 'hash', label: 'Setter', value: entry.owner }];
          const ens = ownerEnsName(entry.owner);
          return ens
            ? ensRows(entry, ens, names)
            : [{ kind: 'tag', label: roleNames[entry.role] ?? `Unknown role ${String(entry.role)}`, value: entry.owner, tone: 'warn', tag: 'Not an ENS name' }];
        }),
        ...(named.length > 0 ? [{ kind: 'text', text: `${vouchNote(named)} ${sepoliaName}` } as const] : []),
      ],
    };
  } catch (error) {
    const message = (error as Error).message;
    return { entries: null, items: [fail('List decode', 'The approved list on the public record can’t be read.', message)] };
  }
}

/**
 * Key holders and centres on the list whose `owner` is not an ENS name. Paper Seal asks for one (spec/api.md,
 * "Party Names"), but the contract does not check it, so an older exam or a board that skipped the app can
 * list one. It is a thing to ask about and never a failed check.
 */
function notEnsNames(chain: ChainData | null): number {
  if (!chain?.entries) return 0;
  try {
    return decodeApprovedList(fromHex(chain.entries)).filter((entry) => entry.role !== roles.setter && ownerEnsName(entry.owner) === null).length;
  } catch {
    return 0;
  }
}

function notEnsNameWarning(chain: ChainData | null): string | null {
  const count = notEnsNames(chain);
  if (count === 0) return null;
  const who = count === 1 ? 'One key holder or centre on the list is' : `${String(count)} key holders or centres on the list are`;
  return `${who} not named by an ENS name, so ${count === 1 ? 'that name' : 'those names'} can't be checked. This does not fail the exam, but ask your exam board why.`;
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
      note: 'The list is on the public record, but this page could not use it.',
      items: [problemRow('Approved list', problem)],
    };
  }
  if (!view.examId || !chain?.entries || !chain.list) {
    return {
      ...base,
      complete: false,
      note: 'The exam board has not yet published the list of approved people.',
      items: [notChecked('Approved list', 'Not posted')],
    };
  }
  const bytes = fromHex(chain.entries);
  const computed = computedListHash(view.examId, bytes);
  const hashOk = c.checks?.list === 'pass';
  const rows = entryRows(bytes, view.partyNames);
  return {
    ...base,
    complete: hashOk && rows.entries !== null,
    note: rows.entries ? listSummary(rows.entries) : 'The list could not be read. Contact your exam board.',
    items: [
      verdict('List hash matches the chain', hashOk, {
        failure: 'The list of approved people does not match its fingerprint on the public record.',
        hash: computed,
      }),
      build
        ? verdict("Build's approved list hash", sameHex(build.approvedListHash, computed), {
            failure: 'The paper was built for a different list of approved people from the one published.',
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
    failure: 'The rules for choosing questions do not match their fingerprint on the public record.',
  });
  let decoded;
  try {
    decoded = decodeCriteria(bytes);
  } catch (error) {
    const message = (error as Error).message;
    return { ok: false, items: [hashRow, fail('Criteria decode', 'The rules for choosing questions can’t be read.', message)] };
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

/** What the machine says when it has stopped the exam, once it has shown it runs this exam. A note, never a failed check. */
function machineFailed(c: Context): Item[] {
  const { live } = c;
  const reported = liveTrusted(live) && live?.status.ok === true && live.status.value.stage === 'failed';
  return reported
    ? [{ kind: 'text', tone: 'warn', text: 'The machine that builds the paper reports that this exam has stopped. Ask your exam board. Nothing about this is on the public record yet.' }]
    : [];
}

function lockedStep(c: Context): Draft {
  const { exam, build } = c;
  const lockAt = exam ? roundTimeSeconds(Number(exam.settings.lockRound)) : null;
  const { items, ok } = criteriaItems(c);
  // The counts are the Build's own claim. Until the Build is shown to come from the sealed machine
  // they are only a claim, so this step is not done on the Build alone.
  const confirmed = build !== null && buildSignatureItem(c.records?.token ?? null).ok;
  const note = build
    ? confirmed
      ? `${plural(Number(build.selected), 'question')} chosen from a question bank of ${String(build.bankSize)}.`
      : 'A paper is recorded, but its files can’t be checked yet, so the number of questions chosen is not confirmed.'
    : !exam || lockAt === null
      ? 'Waiting for the exam board to publish the exam.'
      : c.lockReached
        ? 'Questions have closed. The paper is published next.'
        : `Setters can send questions until ${c.when(lockAt)}.`;
  return {
    id: 'locked',
    label: 'Questions closed',
    complete: ok && confirmed,
    at: lockAt,
    round: exam ? Number(exam.settings.lockRound) : null,
    note,
    items: [
      ...items,
      build
        ? { kind: 'fact', label: 'Selected from question bank', value: `${String(build.selected)} of ${String(build.bankSize)}` }
        : notChecked('Selected from question bank', 'No Build yet'),
      ...(exam ? [roundRow('Questions close', exam.settings.lockRound, c)] : []),
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
    : { item: fail(label, 'The signature on the paper does not check out.', build.error), ok: false };
}

function manifestItems(result: Sourced<ManifestResult>): { items: Item[]; ok: boolean } {
  if (result.kind !== 'ready') return { items: [sourceGap('Storage manifest', result)], ok: false };
  const { report, owners } = result;
  const hashRow = verdict("Manifest hash matches the Build's storageManifestHash", report.hashCheck, {
    failure: 'The published files are not the ones recorded for this paper.',
    absent: 'No Build yet',
    hash: report.hash,
  });
  if (report.kind === 'malformed') {
    return { ok: false, items: [hashRow, fail('Manifest format', 'The list of published files can’t be read.', report.error)] };
  }
  const coverage = verdict('Lists every file, with one share per key holder on the approved list', report.coverage.check, {
    failure: 'Some published files are missing or do not match the approved list.',
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
      verdict('Manifest is for this exam', report.examIdCheck, { failure: 'The published files are for a different exam.' }),
      coverage,
      ...files,
    ],
  };
}

const lateBuild = 'The paper was sealed in time but recorded after its unlock time. This does not fail the exam, but ask your exam board why it was posted late.';
const sealedAfterUnlock =
  'The sealed machine says it built the paper at or after the unlock time, when the questions could already be opened. This does not fail the exam here, but ask your exam board to explain it.';

/** Where the sealed machine's own round puts the sealing: before questions closed, in time, or too late. */
function sealing(c: Context): 'early' | 'in-time' | 'late' | null {
  const { build, exam } = c;
  if (!build || !exam) return null;
  if (build.builtRound < exam.settings.lockRound) return 'early';
  return build.builtRound >= exam.settings.unlockRound ? 'late' : 'in-time';
}

/** The one warning the Build step earns. Worth a question, never a failure. */
function buildWarning(c: Context): string | null {
  const { build, exam } = c;
  if (!build || !exam) return null;
  if (sealing(c) === 'late') return sealedAfterUnlock;
  const posted = Number(build.postedAt) > roundTimeSeconds(Number(exam.settings.unlockRound));
  return posted && sealing(c) === 'in-time' ? lateBuild : null;
}

function sealedItems(c: Context): Item[] {
  const { build, exam } = c;
  if (!build || !exam) return [];
  const warning = buildWarning(c);
  return [
    { kind: 'fact', label: 'Sealed', value: c.when(roundTimeSeconds(Number(build.builtRound))) },
    { kind: 'fact', label: 'Posted', value: c.when(Number(build.postedAt)) },
    roundRow('Paper sealed', build.builtRound, c),
    sealing(c) === 'early'
      ? fail(
          'Sealed after questions closed',
          'The paper was sealed before questions closed, so it could not have used every question the setters sent.',
          `Sealed at round ${String(build.builtRound)}, questions close at round ${String(exam.settings.lockRound)}`,
        )
      : { kind: 'check', label: 'Sealed after questions closed', status: 'pass' },
    ...(warning ? [{ kind: 'text' as const, tone: 'warn' as const, text: warning }] : []),
  ];
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
      ? 'Paper Seal builds the paper after questions close. No person sees it.'
      : complete
        ? 'The paper is built and sealed. Its files match the public record.'
        : 'The paper is recorded. Its files and signature are not all checked yet.',
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
      ...sealedItems(c),
      signature.item,
      ...manifest.items,
      ...backupItems(records?.backup, [storageNames.manifest]),
    ],
  };
}

/** Until `trusted`, every badge is neutral: a count from an unverified source is hearsay, not evidence. */
function progressItems(progress: ReleaseProgress, trusted: boolean, recorded = true): Item[] {
  return [
    { kind: 'fact', label: 'Key holders released', value: `${String(progress.count)} of ${String(progress.required)} needed${trusted ? '' : ' (not verified)'}` },
    ...progress.rows.map(
      (row): Item => ({
        kind: 'tag',
        label: `${row.owner}, ${roleNames[row.role] ?? 'key holder'}`,
        tone: row.released && trusted ? 'ok' : 'neutral',
        tag: row.released ? 'Released' : 'Not released yet',
      }),
    ),
    ...progress.unknown.map(
      (key): Item =>
        trusted && recorded
          ? { ...fail('Released by a key that is not an approved key holder', 'A security key that is not on the approved list released a part of the key.'), hash: key }
          : { kind: 'tag', label: 'Released by a key that is not an approved key holder', tone: 'neutral', tag: 'Unverified', hash: key },
    ),
  ];
}

function logItems(result: LogVerdict, signatureLabel: string, signatureAbsent: string): Item[] {
  return [
    verdict('Log is for this exam', result.examId, { failure: 'The record of releases is for a different exam.' }),
    verdict('entriesHash matches the entries', result.entriesHash, { failure: 'The record of releases has been changed after it was signed.' }),
    verdict('filesHash matches the files', result.filesHash, { failure: 'The list of key files has been changed after it was signed.' }),
    verdict(signatureLabel, result.signature, {
      failure: 'The record of releases is not signed by the right key.',
      absent: signatureAbsent,
    }),
    ...(result.error ? [fail('Log error', `The release log could not be checked: ${result.error}`, result.error)] : []),
  ];
}

const keyFilesLabel = 'Key files match the signed log';

/** Who a key file is for, in the words of the top of the page. */
const keyFileWords = (file: { owner?: string }) => (file.owner === undefined ? 'The file that opens the paper' : `The copy of the key for ${file.owner}`);

function storedFileItem(file: ReleaseFileReport): Item {
  const recipient = file.owner === undefined ? {} : { detail: `recipient ${file.owner}` };
  const base = { kind: 'check' as const, label: { code: file.name }, hash: file.sha256 };
  if (file.result === 'pass') return { ...base, status: 'pass', ...recipient };
  if (file.problem === 'removed') return { ...base, status: 'fail', detail: 'Removed', failure: `${keyFileWords(file)} was removed from the public files.` };
  if (file.problem === 'changed') return { ...base, status: 'fail', detail: 'Changed', failure: `${keyFileWords(file)} was changed after it was recorded.` };
  const message = typeof file.problem === 'object' ? file.problem.unreadable : 'Not read yet';
  return { ...base, status: 'not-checked', detail: `Could not be read: ${message}` };
}

/** The log's files against the list and storage. Each row that fails reports its own failure. */
function releaseFileItems(report: ReleaseFilesReport | null): Item[] {
  if (!report) return [notChecked(keyFilesLabel, 'Not checked until the log and its proof pass')];
  if (report.pending) return [notChecked(keyFilesLabel, 'Not unlocked yet. The log lists them once enough key holders have released.')];
  const failure = 'The signed log does not list the right key files for this exam.';
  const names: Item =
    report.names === 'absent'
      ? notChecked(keyFilesLabel, 'No approved list to compare with')
      : { kind: 'check', label: 'Lists the key file and one copy for each centre on the approved list', status: report.names, failure, quiet: true };
  return [
    names,
    ...report.missing.map((file) => fail({ code: file.name }, `${keyFileWords(file)} is not in the signed log.`, 'Not listed')),
    ...report.extra.map((name) => fail({ code: name }, 'The signed log lists a copy of the key for someone who is not on the approved list.', 'Not on the approved list')),
    ...report.files.map(storedFileItem),
  ];
}

function publishedLogItems(log: Records['log'] | null): { items: Item[]; verified: ReleaseProgress | null; said: ReleaseProgress | null; complete: boolean } {
  const empty = { verified: null, said: null, complete: false };
  if (!log) return { ...empty, items: [notChecked('Published release log', 'Not read yet')] };
  if (log.kind === 'malformed') {
    return { ...empty, items: [fail('Release log format', `The release log can't be read: ${log.message}`, log.message)] };
  }
  if (log.kind !== 'ready') return { ...empty, items: [sourceGap('Published release log', log)] };
  const { token, progress, files } = log;
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
      log.verdict.filesHash === 'pass' &&
      log.verdict.signature === 'pass' &&
      files?.check === 'pass' &&
      progress !== null &&
      progress.count >= progress.required,
    items: [
      ...(trusted
        ? []
        : [{ kind: 'text' as const, tone: 'warn' as const, text: 'Not verified. Until this proof passes, nothing says who signed this log, so its list of releases is not evidence.' }]),
      ...logItems(log.verdict, 'Signed by the key the log names', 'Not checked'),
      ...(progress ? progressItems(progress, trusted) : []),
      token
        ? token.verified
          ? { kind: 'check', label: 'release-token.jwt attests the key that signed the log', status: 'pass' }
          : fail(
              'release-token.jwt attests the key that signed the log',
              'The proof behind the release log does not pass.',
              tokenProblem,
            )
        : notChecked('release-token.jwt attests the key that signed the log', 'Not in storage yet or the exam is not published'),
      ...releaseFileItems(files),
    ],
  };
}

/**
 * Progress from the live machine, only while the exam is under way and nothing is recorded yet. It
 * can show a count and nothing more: no row here can fail, and it never finishes a step.
 */
function liveReleaseItems(c: Context, recorded: boolean): Item[] {
  if (recorded || c.endReached) return [];
  const heading: Item = { kind: 'heading', text: 'Live from the machine, optional' };
  if (!c.view.sources.tee) return [heading, { kind: 'text', text: needsTee }];
  const { live } = c;
  if (!live) {
    const message = c.view.live.state === 'error' ? `Could not be read: ${c.view.live.message}` : 'Not read yet';
    return [heading, notChecked('Live release', message)];
  }
  if (live.otherExam) return [heading, ...liveNote(c)];
  const trusted = liveTrusted(live);
  const stage = live.status.ok ? live.status.value : null;
  const stateItems: Item[] = !stage
    ? [notChecked('Stage', live.status.ok ? 'Not read yet' : `Could not be read: ${live.status.message}`)]
    : [
        { kind: 'fact', label: 'Stage', value: `${stage.stage}${trusted ? '' : ' (not verified)'}` },
        ...(live.progress
          ? progressItems(live.progress, trusted, false)
          : [
              {
                kind: 'fact' as const,
                label: 'Key holders released',
                value: `${String(stage.release.released.length)} of ${String(stage.release.required)} needed${trusted ? '' : ' (not verified)'}`,
              },
            ]),
      ];
  return [
    heading,
    {
      kind: 'text',
      ...(trusted
        ? { text: 'This is progress so far. The record of it is published when the exam reaches that point, and only the record counts.' }
        : { text: 'Not verified. The machine has not shown it is running this exam, so what it reports here is not evidence.', tone: 'warn' as const }),
    },
    ...stateItems,
  ];
}

export type ProgressSource = 'storage' | 'tee' | 'arkiv';

const sourceNames: Record<ProgressSource, string> = {
  storage: 'The public files',
  tee: 'The live machine',
  arkiv: 'The copy on Arkiv',
};

/** The quiet line under the note, so the viewer knows which source the count came from. */
const sourceAsides: Record<ProgressSource, string> = {
  storage: 'Read from the public files.',
  tee: 'Read from the live machine, which passed its check.',
  arkiv: 'Read from the copy on Arkiv. Every row shown passed its check.',
};

/** How many keys a log shows as released, the approved ones and any others. */
const releasedKeys = (progress: ReleaseProgress) => progress.count + progress.unknown.length;

/**
 * The verified progress with the most releases, and where it came from. Logs only grow, and every
 * one here is signed by an attested key, so the larger one is simply the later one.
 */
function shownProgress(c: Context, published: ReleaseProgress | null): { progress: ReleaseProgress; source: ProgressSource } | null {
  const candidates: { progress: ReleaseProgress | null | undefined; source: ProgressSource }[] = [
    { progress: published, source: 'storage' },
    { progress: c.arkiv?.log?.progress, source: 'arkiv' },
  ];
  let best: { progress: ReleaseProgress; source: ProgressSource } | null = null;
  for (const { progress, source } of candidates) {
    if (progress && (!best || releasedKeys(progress) > releasedKeys(best.progress))) best = { progress, source };
  }
  if (best) return best;
  // Nothing recorded yet, so a machine that has shown it runs this exam may give the count so far.
  const live = liveTrusted(c.live) && !c.endReached ? c.live?.progress : null;
  return live ? { progress: live, source: 'tee' } : null;
}

/** Who has released, in the strongest words the evidence allows. */
function releaseLine(c: Context, published: ReleaseProgress | null, said: ReleaseProgress | null): string {
  const known = shownProgress(c, published)?.progress;
  if (known) return `${String(known.count)} of the ${String(known.required)} needed key holders have released.`;
  const unverified = said ?? c.live?.progress ?? null;
  if (unverified) return `${String(unverified.count)} of the ${String(unverified.required)} needed key holders may have released. This is not verified yet.`;
  return 'No release has been verified yet.';
}

function ignoredWords(ignored: ArkivIgnored): string {
  const parts = [
    ignored.tokens > 0 ? `${plural(ignored.tokens, 'release token')} that did not pass the check` : null,
    ignored.unreadable > 0 ? `${plural(ignored.unreadable, 'release log')} that could not be read` : null,
    ignored.unattested > 0 ? `${plural(ignored.unattested, 'release log')} not signed by a key a passing token attests` : null,
    ignored.failed > 0 ? `${plural(ignored.failed, 'release log')} that did not pass the check` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(', ') : 'None';
}

const originWords: Record<WriterOrigin, string> = {
  name: 'From the name',
  own: 'Your own choice',
  built: 'Built into this page',
};

/** `From the name and your own choice`. */
function originTag(from: readonly WriterOrigin[]): string {
  const words = from.map((origin, index) => (index === 0 ? originWords[origin] : originWords[origin].toLowerCase()));
  return words.join(' and ');
}

/** Each writer read, and where it came from when the page knows. */
function writerItems(c: Context, report: ArkivReport): Item[] {
  const sourced = c.view.arkivWriters;
  if (!sourced) return [{ kind: 'fact', label: 'Writers read', value: report.writers.join(', ') }];
  const known = new Map(sourced.map((writer) => [writer.address.toLowerCase(), writer.from]));
  return report.writers.map((address) => {
    const from = known.get(address.toLowerCase()) ?? [];
    return from.length > 0
      ? { kind: 'tag' as const, label: 'Writer read', tone: 'neutral' as const, tag: originTag(from), value: address }
      : { kind: 'fact' as const, label: 'Writer read', value: address };
  });
}

/** The name's writer record entries that are not addresses. Never a failure: they are only not read. */
function ignoredWriterItems(c: Context): Item[] {
  const ignored = c.view.arkivWritersIgnored ?? [];
  if (ignored.length === 0) return [];
  const one = ignored.length === 1;
  return [
    {
      kind: 'text',
      text: `The exam's name also lists ${ignored.join(', ')}. ${one ? 'It is not an address' : 'They are not addresses'}, so this page does not read ${one ? 'it' : 'them'}.`,
    },
  ];
}

/**
 * Arkiv evidence. Rows that don't verify are counted, never shown as progress, and never fail the
 * step. Heartbeats only say a writer is running: they are shown, and never count.
 */
function arkivItems(c: Context, over: boolean): Item[] {
  const heading: Item = { kind: 'heading', text: 'Copy on Arkiv, optional' };
  const ignoredWriters = ignoredWriterItems(c);
  if (!c.view.sources.arkiv) return [heading, { kind: 'text', text: needsArkiv }, ...ignoredWriters];
  const polled = c.view.arkiv;
  if (polled.state === 'error') return [heading, notChecked('Copy on Arkiv', `Could not be read: ${polled.message}`), ...ignoredWriters];
  if (polled.state !== 'ready') return [heading, notChecked('Copy on Arkiv', 'Not read yet'), ...ignoredWriters];
  if ('kind' in polled.value) return [heading, notChecked('Copy on Arkiv', polled.value.message), ...ignoredWriters];
  const report = polled.value;
  const { log, heartbeat } = report;
  // Rule 4: only while unlock is open, and timed by Arkiv's blocks, never this device's clock.
  const open = c.unlockReached && !over;
  const age = report.ageSeconds;
  const stale = open && age !== null && age > ARKIV_STALE_AFTER_SECONDS;
  const silent = open && age === null;
  const readAt = new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium', ...(c.view.timeZone ? { timeZone: c.view.timeZone } : {}) });
  return [
    heading,
    ...(stale
      ? [
          {
            kind: 'text' as const,
            tone: 'warn' as const,
            text: `The Arkiv copy stopped updating ${plural(Math.floor(age / 60), 'minute')} ago. That does not mean no one has released since. This page keeps reading it.`,
          },
        ]
      : []),
    ...(silent
      ? [
          {
            kind: 'text' as const,
            tone: 'warn' as const,
            text: 'No relay has written to Arkiv for this exam since unlock opened. That does not mean no one has released. This page keeps reading it.',
          },
        ]
      : []),
    ...(polled.stale
      ? [{ kind: 'text' as const, text: `The copy on Arkiv could not be read again, so this shows what it said at ${readAt.format(polled.readAt)}. This page keeps trying.` }]
      : []),
    ...writerItems(c, report),
    ...ignoredWriters,
    {
      kind: 'fact',
      label: 'Rows read',
      value: `${plural(report.read.logs, 'release log')}, ${plural(report.read.tokens, 'release token')}, ${plural(report.read.heartbeats, 'heartbeat')}`,
    },
    ...(log
      ? ([
          { kind: 'check', label: 'Release log signed by a key a passing release token attests', status: 'pass' },
          { kind: 'hash', label: 'Entity key of the log shown', value: log.entityKey },
          { kind: 'link', href: `${arkiv.network.explorer}/entity/${log.entityKey}`, text: 'Open this row in the Arkiv explorer' },
          { kind: 'fact', label: 'Written by', value: log.creator },
          { kind: 'fact', label: 'Written at', value: utcTime(log.writtenAt) },
          ...(log.progress ? progressItems(log.progress, true) : []),
        ] satisfies Item[])
      : [
          notChecked(
            'Release log',
            report.read.logs === 0 ? 'No release log on Arkiv yet' : 'No release log on Arkiv has passed its check yet',
          ),
        ]),
    { kind: 'fact', label: 'Rows ignored', value: ignoredWords(report.ignored) },
    ...(heartbeat
      ? ([
          { kind: 'fact', label: 'Newest heartbeat written at', value: utcTime(heartbeat.writtenAt) },
          { kind: 'fact', label: 'Stage the relay last read, as it says', value: heartbeat.stage || 'Not given' },
        ] satisfies Item[])
      : []),
    ...(report.newestAt === null ? [] : [{ kind: 'fact' as const, label: 'Relay last wrote at', value: utcTime(report.newestAt) }]),
  ];
}

function unlockStep(c: Context, sealedOff: boolean): Draft {
  const { exam, build } = c;
  const logs = publishedLogItems(c.records?.log ?? null);
  const fromArkiv = c.arkiv?.log?.progress ?? null;
  const arkivComplete = fromArkiv !== null && fromArkiv.count >= fromArkiv.required;
  const complete = logs.complete || arkivComplete;
  const shown = shownProgress(c, logs.verified);
  const unlockAt = exam ? roundTimeSeconds(Number(exam.settings.unlockRound)) : null;
  const countdown: Item[] = exam
    ? [
        ...(tooFar(unlockAt ?? 0)
          ? []
          : [
              {
                kind: 'countdown' as const,
                at: (unlockAt ?? 0) * 1000,
                round: Number(exam.settings.unlockRound),
                label: 'Paper unlocks',
                reached: c.unlockReached ? 'Unlocked' : 'Due, waiting for the public clock',
              },
            ]),
        c.view.latest.round !== null
          ? { kind: 'fact', label: 'Latest public clock round', value: c.view.latest.round.toLocaleString('en-GB') }
          : notChecked('Latest public clock round', c.view.latest.error ? 'Public clock not reached' : 'Loading'),
        roundRow('Questions close', exam.settings.lockRound, c),
        roundRow('Paper unlocks for centres', exam.settings.unlockRound, c),
        roundRow('Paper opens to everyone', exam.settings.endRound, c),
      ]
    : [];
  const noPaper = c.endReached && build === null;
  const note = complete
    ? releaseLine(c, logs.verified, logs.said)
    : noPaper
      ? 'No paper was made, so there is nothing to unlock.'
      : sealedOff
        ? 'The paper was never unlocked.'
        : !exam || unlockAt === null
          ? 'Waiting for the exam board to publish the exam.'
          : c.unlockReached
            ? `Unlocked. ${releaseLine(c, logs.verified, logs.said)}`
            : `Opens to centres at ${c.when(unlockAt)}. Nothing can open it sooner.`;
  // The source is named only where the note gives a count.
  const counted = complete || (!noPaper && !sealedOff && exam !== null && c.unlockReached);
  return {
    id: 'unlock',
    label: 'Paper unlocks for centres',
    complete,
    notApplicable: noPaper || sealedOff,
    at: unlockAt,
    round: exam ? Number(exam.settings.unlockRound) : null,
    note,
    ...(counted && shown ? { aside: sourceAsides[shown.source] } : {}),
    items: [
      ...countdown,
      ...(shown ? [{ kind: 'fact' as const, label: 'Progress shown is from', value: sourceNames[shown.source] }] : []),
      { kind: 'heading', text: 'Published release log' },
      ...logs.items,
      ...backupItems(c.records?.backup, [storageNames.releaseLog, releaseTokenName]),
      ...liveReleaseItems(c, shown !== null && shown.source !== 'tee'),
      ...arkivItems(c, complete || c.endReached || noPaper || sealedOff),
      ...(build ? machineFailed(c) : []),
    ],
  };
}

const proofLabels: Record<keyof ProofChecks, { label: string; failure: string }> = {
  paperFile: { label: 'paper.bin is the file the Build hashed (paperHash)', failure: 'The published paper file is not the one recorded for this exam.' },
  saltedHash: { label: 'Seed and paper give the Build’s saltedPaperHash', failure: 'The opened paper is not the paper recorded for this exam.' },
  examId: { label: 'Paper is for this exam', failure: 'The opened paper is for a different exam.' },
  selectedCount: { label: 'Question count equals the Build’s selected', failure: 'The paper has a different number of questions from the one recorded.' },
  criteriaCount: { label: 'Build’s selected equals the published criteria’s total', failure: 'The recorded paper has a different number of questions from the published rules.' },
  topics: { label: 'Each topic has the question count the criteria ask for', failure: 'A topic in the paper does not have the number of questions the criteria ask for.' },
  criteriaHash: { label: 'Published criteria match the exam’s criteriaHash', failure: 'The published criteria do not match the fingerprint on the public record.' },
};

const proofNames = Object.keys(proofLabels) as (keyof ProofChecks)[];

function proofItems(proof: Extract<ProofRun, { ok: true }>['result']): { items: Item[]; complete: boolean; note: string } {
  switch (proof.state) {
    case 'not-ready':
      return { items: [notChecked('Proof', proof.reason)], complete: false, note: proof.reason };
    case 'waiting':
      return { items: [notChecked('Proof', 'The exam has not ended yet.')], complete: false, note: 'The exam has not ended yet.' };
    case 'sealed':
      return {
        complete: false,
        note: 'The paper cannot be opened.',
        items: [
          notChecked('Proof', 'The paper cannot be opened'),
          {
            kind: 'text',
            text: `The exam has ended, but the public files hold no ${storageNames.keyPriv}. If the paper was never unlocked, the time-locked key was never published, so nobody can open the paper. If you expected it to open, check where the public files are kept under "Check it yourself".`,
          },
        ],
      };
    case 'failed': {
      const label = proof.step === 'files' ? 'Files' : proof.step === 'timelock' ? 'Time lock' : 'Opening the paper';
      // A file that is gone or changed is the finding itself, so it goes to the top of the page.
      const failure = proof.step === 'files' ? proof.message : 'The paper could not be opened.';
      return { complete: false, note: 'The paper could not be opened.', items: [fail(label, failure, proof.message)] };
    }
    case 'opened': {
      const results = proofNames.map((name) =>
        verdict(proofLabels[name].label, proof.checks[name], { failure: proofLabels[name].failure, absent: 'No criteria on the chain' }),
      );
      const passed = proofNames.filter((name) => proof.checks[name] === 'pass').length;
      const complete = passed === proofNames.length && proof.paper !== null && !proof.parseError;
      return {
        complete,
        note: complete ? `The paper is open to everyone. All ${String(passed)} checks passed.` : `The paper is open. ${String(passed)} of ${String(proofNames.length)} checks passed.`,
        items: [
          ...results,
          ...(proof.parseError ? [fail('Paper format', 'The opened paper can’t be read.', proof.parseError)] : []),
          {
            kind: 'text',
            text: 'Which questions were chosen is vouched for by Paper Seal, not independently proven, because the question bank stays hidden. These checks show this is the paper that was recorded, not what a centre showed students.',
          },
          ...(proof.paper ? [] : [notChecked('Paper withheld', 'The paper is open, but it is not shown because it does not match the recorded paper.')]),
        ],
      };
    }
  }
}

/** The files the proof reads. */
const proofFiles = [storageNames.keyPriv, storageNames.keyPub, storageNames.paper];

function openStep(c: Context): Draft {
  const { exam, build } = c;
  const endRound = exam ? Number(exam.settings.endRound) : null;
  const endAt = endRound === null ? null : roundTimeSeconds(endRound);
  const base = { id: 'open' as const, label: 'Paper opens to everyone', at: endAt, round: endRound };
  if (!exam || endRound === null || endAt === null) {
    return { ...base, complete: false, note: 'Waiting for the exam board to publish the exam.', items: [notChecked('Proof', 'The exam is not on the public record yet.')] };
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
          text: `The paper opens when the public clock reaches round ${String(endRound)}, at ${utcTime(endAt)}. Nothing here can open it sooner.`,
        },
      ],
    };
  }
  if (build === null) {
    return { ...base, complete: false, notApplicable: true, note: 'No paper was made, so there is nothing to open.', items: [notChecked('Proof', 'No paper is recorded to compare with.')] };
  }
  const { proof } = c.view;
  if (!c.view.sources.storage) return { ...base, complete: false, note: 'This page needs to know where the public files are kept.', items: [notChecked('Proof', needsStorage)] };
  if (!proof) return { ...base, complete: false, note: 'Opening the paper.', items: [notChecked('Proof', 'Opening the paper.')] };
  if (!proof.ok) {
    return {
      ...base,
      complete: false,
      note: 'The paper could not be opened just now. This page tries again by itself.',
      items: [notChecked('Proof', `Could not be read: ${proof.message}`), ...backupItems(proof.backup, proofFiles)],
    };
  }
  const result = proofItems(proof.result);
  return {
    ...base,
    complete: result.complete,
    notApplicable: proof.result.state === 'sealed',
    note: result.note,
    items: [...result.items, ...backupItems(proof.backup, proofFiles)],
  };
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
    if (failures.length > 0) {
      state = 'failed';
      if (draft.stops) holding = true;
    } else if (draft.complete) state = 'done';
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
      ...(draft.aside ? { aside: draft.aside } : {}),
      items: draft.items,
      failures,
    };
  });
}

const BEFORE_SEAL: readonly StepId[] = ['name', 'published', 'attested', 'people', 'locked', 'sealed'];

function sealOf(c: Context, steps: readonly CustodyStep[]): SealState | null {
  const { proof } = c.view;
  const opened = proof?.ok === true ? proof.result.state : null;
  // The seal breaks only for a real problem. Before there is a paper there is no seal to break.
  if (opened === 'failed') return 'broken';
  if (c.build && steps.some((step) => step.state === 'failed')) return 'broken';
  // Open is a seal of approval, so it waits for the last check.
  if (opened === 'opened') return steps.find((step) => step.id === 'open')?.state === 'done' ? 'open' : 'opening';
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
  const again = 'This page tries again by itself. You can also choose another source under "Check it yourself" below.';
  if (view.name) {
    const { result } = view.name;
    if (result.state === 'off') return { headline: 'This page cannot read the public record yet.', next: 'Add where to read it under "Check it yourself" below. Nothing has been checked yet.' };
    if (result.state === 'loading') return { headline: 'Checking the exam name.', next: 'This takes a few seconds. Keep this page open.' };
    if (result.state === 'error' || (!result.value.ok && result.value.failed === 'unreadable')) {
      return { headline: 'The exam name could not be read.', next: again };
    }
    if (!result.value.ok) return { headline: 'This name does not lead to a verified exam.', next: 'Ask your exam board for the right name. Nothing after the name has been checked.' };
  }
  if (view.invalidLink) return { headline: 'This link does not name an exam.', next: 'Ask your exam board for the right link, or enter the exam ID below.' };
  if (!view.examId) return { headline: 'Choose an exam to check.', next: 'Enter the exam ID below, or open the link your exam board shared.' };
  if (!view.sources.chain) return { headline: 'This page cannot read the public record yet.', next: 'Add where to read it under "Check it yourself" below. Nothing has been checked yet.' };
  if (view.records.state === 'loading') return { headline: 'Reading the public record.', next: 'This takes a few seconds. Keep this page open.' };
  if (view.records.state === 'error') return { headline: 'The public record could not be read.', next: again };
  return null;
}

function examWords(c: Context, steps: readonly CustodyStep[], seal: SealState | null, proofState: string | null): Words {
  const { exam, build, chain } = c;
  const auto = 'This page updates by itself.';
  if (chain && chain.registryCode.state !== 'match') {
    return { headline: 'This is not a Paper Seal exam record.', next: 'Ask your exam board for the right address, then enter it under "Check it yourself" below.' };
  }
  if (!exam) return { headline: 'This exam is not on the public record.', next: `Once the exam board publishes it, it will appear here. ${auto}` };
  const unlockAt = roundTimeSeconds(Number(exam.settings.unlockRound));
  const lockAt = roundTimeSeconds(Number(exam.settings.lockRound));
  const endAt = roundTimeSeconds(Number(exam.settings.endRound));
  const state = (id: StepId) => steps.find((step) => step.id === id)?.state;
  if (proofState === 'opened') {
    return state('open') === 'done' && steps.every((step) => step.state !== 'failed')
      ? { headline: 'The paper is open. Anyone can read it and check it.', next: 'Nothing more is needed. Anyone can repeat these checks at any time.' }
      : { headline: 'The paper is open, but it did not pass every check.', next: 'Contact your exam board and tell them which checks failed.' };
  }
  if (c.endReached) {
    if (!build) return { headline: 'The exam ended and no paper was published.', next: 'Nothing more is needed. Contact your exam board if you expected a paper.' };
    if (proofState === 'sealed') return { headline: 'The paper stays sealed. It was never unlocked.', next: 'Nobody can open this paper now. Contact your exam board if you expected it to open.' };
    if (proofState === 'failed') return { headline: 'The paper could not be opened.', next: 'Contact your exam board and tell them which check failed.' };
    return { headline: 'The exam is over. The paper is opening.', next: 'The public clock has opened the paper. This page is checking it now.' };
  }
  if (!chain?.list) return { headline: 'Setting up. The list of approved people is not published yet.', next: `The exam board publishes the list next. ${auto}` };
  if (!build) {
    return c.lockReached
      ? { headline: 'Questions have closed. The paper is not published yet.', next: `Paper Seal builds the paper next. No person sees it. ${auto}` }
      : { headline: `Questions are coming in. They close at ${c.when(lockAt)}.`, next: 'After that Paper Seal builds the paper. No person sees it.' };
  }
  if (BEFORE_SEAL.some((id) => state(id) === 'failed')) {
    return { headline: 'The paper is published, but it failed its checks.', next: 'Contact your exam board and tell them which check failed.' };
  }
  if (seal === null) return { headline: 'The paper is published. Its checks are not finished.', next: `The checks finish once the published files can be read. ${auto}` };
  if (!c.unlockReached) {
    return { headline: `The paper is sealed. It unlocks for centres at ${c.when(unlockAt)}.`, next: 'At that time key holders release their parts of the key.' };
  }
  if (state('unlock') === 'done') {
    return { headline: `Key holders have released their parts. The paper opens to everyone at ${c.when(endAt)}.`, next: 'After the exam the public clock opens the paper, and this page checks it.' };
  }
  const last = steps.find((step) => step.id === 'unlock');
  return { headline: `Unlocking for centres. ${last?.note.replace('Unlocked. ', '') ?? ''}`.trim(), next: 'Once enough key holders have released, centres can open the paper.' };
}

function verdictLine(c: Context, steps: readonly CustodyStep[], failures: readonly Failure[]): string {
  if (failures.length > 0) {
    return failures.length === 1 ? 'One check failed. Do not rely on this exam until your exam board explains it.' : `${String(failures.length)} checks failed. Do not rely on this exam until your exam board explains them.`;
  }
  if (!c.exam) return 'Nothing has been checked yet.';
  const done = steps.filter((step) => step.state === 'done').length;
  if (done === steps.length) return 'Every step has been checked. Nothing failed.';
  const gaps = [c.records?.token, c.records?.manifest, c.records?.log].some(
    (source) => source !== undefined && source !== null && source.kind !== 'ready' && source.kind !== 'malformed',
  );
  if (gaps) return 'Nothing has failed so far, but some public files could not be read yet, so those steps are not confirmed.';
  return `This exam is on track. Nothing has failed so far. ${String(done)} of ${String(steps.length)} steps are confirmed.`;
}

/** The whole chain of custody, as it stands at this moment. */
export function custody(given: View): Custody {
  // On a name route the name comes first, and nothing read for the exam counts until it passes.
  const named = given.name ? nameStep(given.name) : null;
  const view: View = named && !named.complete ? { ...given, records: { state: 'off' }, live: { state: 'off' }, arkiv: { state: 'off' }, proof: null } : given;
  const records = view.records.state === 'ready' ? view.records.value : null;
  const chain = records?.chain ?? null;
  const exam = chain?.exam ?? null;
  const build = chain?.build ?? null;
  const live = view.live.state === 'ready' && !('kind' in view.live.value) ? view.live.value : null;
  const arkivReport = view.arkiv.state === 'ready' && !('kind' in view.arkiv.value) ? view.arkiv.value : null;
  const reached = (round: bigint | undefined) => round !== undefined && roundReached(Number(round), view.latest.round, view.now);

  const c: Context = {
    view,
    chain,
    exam,
    build,
    checks: chain ? chainChecks(view.examId, chain) : null,
    records,
    live,
    arkiv: arkivReport,
    lockReached: reached(exam?.settings.lockRound),
    unlockReached: reached(exam?.settings.unlockRound),
    endReached: reached(exam?.settings.endRound),
    when: (seconds) => `${clockTime(seconds, view.now, view.timeZone)}, ${inWords(seconds - view.now)}`,
  };

  const proof = view.proof?.ok === true ? view.proof.result : null;
  const logReady = records?.log.kind === 'ready';
  // Nothing in storage at the end round: no copy of the key exists, so the unlock never happened.
  const unlockOff = proof?.state === 'sealed' && !logReady;
  const examSteps = [
    publishedStep(c),
    attestedStep(c),
    peopleStep(c),
    lockedStep(c),
    sealedStep(c),
    unlockStep(c, unlockOff),
    openStep(c),
  ];
  const steps = settle(named ? [named, ...(named.complete ? examSteps : examSteps.map(held))] : examSteps);

  const failures = steps.flatMap((step) => step.failures.map((message) => ({ step: step.number, label: step.label, message })));
  const seal = sealOf(c, steps);
  const paper = proof?.state === 'opened' ? proof.paper : null;
  const words = noExamWords(view) ?? examWords(c, steps, seal, proof?.state ?? null);
  return {
    steps,
    failures,
    warnings: [...(given.name && differentRegistry(given.name) ? [otherRegistry] : []), ...(buildWarning(c) ? [buildWarning(c) as string] : []), ...(notEnsNameWarning(chain) ? [notEnsNameWarning(chain) as string] : [])],
    seal,
    testNetwork: testNetworkNote(seal),
    noSeal: build ? 'Not confirmed yet' : 'Not sealed yet',
    headline: words.headline,
    verdict: verdictLine(c, steps, failures),
    next: failures.length > 0 ? 'Contact your exam board and tell them which check failed. This page keeps checking by itself.' : words.next,
    paper,
    withheld: proof?.state === 'opened' && proof.paper === null,
    progressSource: shownProgress(c, publishedLogItems(records?.log ?? null).verified)?.source ?? null,
  };
}
