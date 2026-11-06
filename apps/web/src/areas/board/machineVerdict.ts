import type { TokenVerdict } from '@paperseal/attestation';
import type { ExamRegistry } from '@paperseal/chain';
import { roundTimeSeconds, type Hex } from '@paperseal/protocol';
import type { AttestationResponse, TeeClient } from '@paperseal/tee-client';

import { attestationChecker } from '../../shared/attest';
import { teeStorageBucket } from '../../shared/config';
import { examIdInToken } from '../../shared/machineExam';
import { withDeadline } from './homeReads';

/*
 * Whether the sealed machine is set up for an exam. There is one machine and it serves one exam at a
 * time, so its attestation is fetched once and every exam is compared with that one answer. The
 * comparison is `attestationChecker`, the same check that guards sending anything to the machine,
 * given the exam already read from the chain. Only a token that check trusts reads as ready.
 * The verifier does not use this: it judges recorded evidence, not the live machine.
 */

/** How often the machine is asked again. */
export const MACHINE_POLL_MS = 30_000;
/** How long the machine has to answer before it counts as out of reach. */
export const MACHINE_READ_TIMEOUT_MS = 10_000;

export type ChainExam = NonNullable<Awaited<ReturnType<ExamRegistry['getExam']>>>;

/** The one answer from the machine, shared by every exam on the page. */
export type MachineRead =
  | { state: 'unconnected' }
  | { state: 'unreachable'; detail: string }
  /** `misses` counts failed reads since this answer, so one blip does not replace a good answer. */
  | { state: 'answered'; attestation: AttestationResponse; misses: number };

/** Never rejects and never hangs. A good answer is kept through one failed read. */
export async function readMachine(
  tee: Pick<TeeClient, 'attestation'> | null | undefined,
  previous: MachineRead | null = null,
  timeoutMs = MACHINE_READ_TIMEOUT_MS,
): Promise<MachineRead> {
  if (!tee) return { state: 'unconnected' };
  try {
    const attestation = (await withDeadline(tee.attestation(), timeoutMs)) as AttestationResponse | null | undefined;
    if (!attestation) throw new Error('The machine sent an empty answer.');
    return { state: 'answered', attestation, misses: 0 };
  } catch (error) {
    if (previous?.state === 'answered' && previous.misses === 0) return { ...previous, misses: 1 };
    return { state: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }
}

export type MachineVerdict =
  | { state: 'ready' }
  | { state: 'other'; examId: Hex }
  /** It names this exam, but `differs` does not match the public record. */
  | { state: 'mismatch'; differs: string[]; detail: string }
  /** It answered, but its token did not verify, as on a local machine. */
  | { state: 'not-attested'; detail: string }
  | { state: 'unreachable'; detail: string }
  | { state: 'cant-check'; detail: string };

export type MachineState = MachineVerdict | { state: 'finished' } | { state: 'checking' };

/** The settings by their start argument, in words. */
const settingWords: Record<string, string> = {
  'exam-id': 'exam ID',
  'exam-start': 'exam start time',
  delta: 'release time',
  'lock-round': 'time questions close',
  'unlock-round': 'time the paper unlocks',
  'end-round': 'time the paper opens to everyone',
  'criteria-hash': 'topics',
  'rpc-host': 'public record connection',
  registry: 'public record address',
  'chain-id': 'network',
};

/** What says the token is from a genuine, protected Paper Seal machine, whichever exam it runs. */
const machineClaims: ReadonlySet<string> = new Set(['iss', 'aud', 'swname', 'dbgstat', 'hwmodel', 'secboot', 'support_attributes']);

function startArguments(list: unknown): Map<string, string> {
  const found = new Map<string, string>();
  if (!Array.isArray(list)) return found;
  for (const item of list as unknown[]) {
    const match = typeof item === 'string' ? /^--([a-z-]+)=(.*)$/.exec(item) : null;
    if (match?.[1]) found.set(match[1], match[2] ?? '');
  }
  return found;
}

/** Which settings differ, from a failed claim's own expected and actual values. */
function settingsThatDiffer(expected: string, actual: unknown): string[] {
  const wanted = startArguments(JSON.parse(expected));
  const given = startArguments(actual);
  const names = [...new Set([...wanted.keys(), ...given.keys()])].filter((name) => wanted.get(name) !== given.get(name));
  return names.length > 0 ? names.map((name) => settingWords[name] ?? name) : ['start settings'];
}

/** The parts that differ, in words, each once. */
export function differingParts(verdict: TokenVerdict): string[] {
  const parts: string[] = [];
  if (!verdict.instanceKey.ok) parts.push('machine identity');
  for (const claim of verdict.claims) {
    if (claim.ok) continue;
    if (claim.claim === 'image_digest') parts.unshift('code');
    else if (claim.claim === 'args' || claim.claim === 'cmd_override') parts.push(...settingsThatDiffer(claim.expected, claim.actual));
    else if (claim.claim === 'env_override') parts.push('storage location');
    else if (claim.claim === 'eat_nonce') parts.push('machine identity');
    else parts.push('machine protection');
  }
  return [...new Set(parts)];
}

/** Every failed part, for the folded details. */
function failures(verdict: TokenVerdict): string {
  const lines: string[] = [];
  if (!verdict.signature.ok) lines.push(`token signature: ${verdict.signature.error.message}`);
  if (!verdict.instanceKey.ok) lines.push(`instance key: ${verdict.instanceKey.error ?? 'not signed by the instance key'}`);
  for (const claim of verdict.claims) {
    if (!claim.ok) lines.push(`${claim.claim}: expected ${claim.expected}, got ${JSON.stringify(claim.actual) ?? 'nothing'}${claim.note ? ` (${claim.note})` : ''}`);
  }
  return lines.join('\n');
}

export interface MachineExam {
  examId: Hex;
  exam: ChainExam;
  /** The registry this app uses, never one read from the token. */
  registry: Hex;
  /** Overrides `VITE_TEE_STORAGE_BUCKET`. */
  storageBucket?: string;
  /** Unix seconds. */
  now?: () => number;
}

/** Compares the machine's one answer with one exam on the chain. Never rejects. */
export async function judgeMachine(read: MachineRead, input: MachineExam): Promise<MachineVerdict> {
  if (read.state === 'unconnected') return { state: 'cant-check', detail: 'VITE_TEE_URL is not set.' };
  if (read.state === 'unreachable') return read;
  const { attestation } = read;
  if (!attestation.token) return { state: 'not-attested', detail: 'Not attested: the machine sent no token.' };
  const { examId, exam, registry, storageBucket, now } = input;
  const check = attestationChecker({
    // The chain's exam is write-once and already read, so it is not read again for every row.
    registry: { address: registry, getExam: () => Promise.resolve(exam) },
    examId,
    ...(storageBucket === undefined ? {} : { storageBucket }),
    ...(now ? { now } : {}),
  });
  let verdict: TokenVerdict;
  try {
    verdict = await check(attestation);
  } catch (error) {
    return { state: 'not-attested', detail: `Not attested: ${error instanceof Error ? error.message : String(error)}` };
  }
  // Nothing in a token that does not verify can be believed, including the exam it names.
  if (!verdict.signature.ok) return { state: 'not-attested', detail: `Not attested.\n${failures(verdict)}` };
  const failed: readonly string[] = verdict.claims.filter((claim) => !claim.ok).map((claim) => claim.claim);
  if (failed.includes('iat') || failed.includes('exp')) return { state: 'cant-check', detail: failures(verdict) };
  const running = examIdInToken(attestation.token);
  if (!running) return { state: 'cant-check', detail: `The token names no exam.\n${failures(verdict)}` };
  if (running !== examId.toLowerCase()) {
    return failed.some((claim) => machineClaims.has(claim)) ? { state: 'not-attested', detail: `Not attested.\n${failures(verdict)}` } : { state: 'other', examId: running };
  }
  if (verdict.trusted) return { state: 'ready' };
  // A page without its bucket set would otherwise blame the machine for the page's own gap.
  if (failed.includes('env_override') && !(storageBucket ?? teeStorageBucket)) {
    return { state: 'cant-check', detail: `VITE_TEE_STORAGE_BUCKET is not set.\n${failures(verdict)}` };
  }
  return { state: 'mismatch', differs: differingParts(verdict), detail: failures(verdict) };
}

/** The end of the exam, when the paper is open to everyone and nothing needs the machine. */
export function examFinished(exam: ChainExam, nowMs: number): boolean {
  return nowMs >= roundTimeSeconds(Number(exam.settings.endRound)) * 1000;
}

/** What to show. A finished exam never depends on the machine, which has rightly moved on. */
export function machineState(verdict: MachineVerdict | null, exam: ChainExam, nowMs: number): MachineState {
  if (examFinished(exam, nowMs)) return { state: 'finished' };
  return verdict ?? { state: 'checking' };
}

export type MachineTone = 'good' | 'quiet' | 'problem';

export interface MachineWords {
  /** For a row on the home list. */
  short: string;
  title: string;
  lede: string;
  next: string | null;
  tone: MachineTone;
  retry: boolean;
  details: string | null;
}

const listOf = (parts: readonly string[]): string => {
  const last = parts[parts.length - 1] ?? '';
  return parts.length < 2 ? last : `${parts.slice(0, -1).join(', ')} and ${last}`;
};

const ask = 'If it keeps happening, contact whoever runs Paper Seal.';

/** The words for a state. `otherExam` names an exam for the board, `listPosted` says the people are already settled. */
export function machineWords(state: MachineState, context: { otherExam: (id: Hex) => string; listPosted: boolean }): MachineWords {
  const quiet = { tone: 'quiet', retry: false, details: null } as const;
  switch (state.state) {
    case 'checking':
      return { ...quiet, short: 'Checking machine', title: 'Checking the machine', lede: 'This takes a moment.', next: null };
    case 'finished':
      return { ...quiet, short: 'Machine not needed', title: 'Exam finished, the machine is no longer needed', lede: 'Nothing to do here.', next: null };
    case 'ready':
      return {
        short: 'Machine ready',
        title: 'Ready',
        lede: 'The machine is running this exam, with the published code and settings.',
        next: null,
        tone: 'good',
        retry: false,
        details: null,
      };
    case 'other':
      return {
        short: 'Running another exam',
        title: 'Running another exam',
        lede: `The machine is running ${context.otherExam(state.examId)}, so this exam ${context.listPosted ? 'cannot continue' : 'cannot take registrations'} right now.`,
        next: 'Ask whoever runs Paper Seal to start the machine for this exam.',
        tone: 'problem',
        retry: true,
        details: null,
      };
    case 'mismatch':
      return {
        short: "Settings don't match",
        title: "Settings don't match",
        lede: `The machine names this exam, but these differ from what was published: ${listOf(state.differs)}.`,
        next: 'Do not use this exam yet. Ask whoever runs Paper Seal to restart the machine with the published code and settings.',
        tone: 'problem',
        retry: true,
        details: state.detail,
      };
    case 'not-attested':
      return {
        short: 'Machine not confirmed',
        title: 'Machine not confirmed',
        lede: 'The machine answered, but it could not prove it runs the published code.',
        next: 'Do not use this exam yet. Ask whoever runs Paper Seal to check the machine.',
        tone: 'problem',
        retry: true,
        details: state.detail,
      };
    case 'unreachable':
      return {
        short: "Can't reach machine",
        title: "Can't reach the machine",
        lede: 'The machine did not answer.',
        next: `Try again in a minute. ${ask}`,
        tone: 'problem',
        retry: true,
        details: state.detail,
      };
    case 'cant-check':
      return {
        short: "Can't check yet",
        title: "Can't check the machine yet",
        lede: 'The machine could not be checked just now.',
        next: `Try again in a minute. ${ask}`,
        tone: 'problem',
        retry: true,
        details: state.detail,
      };
  }
}
