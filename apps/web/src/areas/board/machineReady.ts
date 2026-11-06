import type { Hex } from '@paperseal/protocol';
import type { TeeClient } from '@paperseal/tee-client';

import { withDeadline } from './homeReads';
import { judgeMachine, MACHINE_READ_TIMEOUT_MS, machineWords, readMachine, type ChainExam } from './machineVerdict';

/*
 * One check of the sealed machine alone, before anyone is asked to register: it answers, it serves this exam,
 * it proves the published code and settings, it is taking registrations, and it can hand out a registration
 * challenge. The challenge is single use, expires and writes nothing, so asking for one changes nothing.
 */

export type ReadyResult = { ok: true } | { ok: false; title: string; lede: string; next: string; details: string | null };

export type ReadyTee = Pick<TeeClient, 'attestation' | 'status' | 'registerChallenge'>;

const ask = 'If it keeps happening, contact whoever runs Paper Seal.';

const fail = (title: string, lede: string, next: string, details: string | null = null): ReadyResult => ({ ok: false, title, lede, next, details });

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Never rejects and never hangs. */
export async function checkMachineReady(
  tee: ReadyTee | null | undefined,
  input: { examId: Hex; exam: ChainExam; registry: Hex; otherExam: (id: Hex) => string },
  timeoutMs = MACHINE_READ_TIMEOUT_MS,
): Promise<ReadyResult> {
  const { examId, exam, registry, otherExam } = input;
  if (!tee) return fail("Can't check the machine yet", 'The machine could not be checked just now.', `Try again in a minute. ${ask}`, 'VITE_TEE_URL is not set.');

  let status: Awaited<ReturnType<ReadyTee['status']>>;
  try {
    status = await withDeadline(tee.status(), timeoutMs);
  } catch (error) {
    return fail("Can't reach the machine", 'The machine did not answer.', `Try again in a minute. ${ask}`, message(error));
  }
  const other = (id: Hex) => {
    const words = machineWords({ state: 'other', examId: id }, { otherExam, listPosted: false });
    return fail(words.title, words.lede, words.next ?? '');
  };
  if (status.examId && status.examId.toLowerCase() !== examId.toLowerCase()) return other(status.examId);

  const read = await readMachine(tee, null, timeoutMs);
  const verdict = await judgeMachine(read, { examId, exam, registry });
  if (verdict.state === 'other') return other(verdict.examId);
  if (verdict.state !== 'ready') {
    const words = machineWords(verdict, { otherExam, listPosted: false });
    return fail(words.title, words.lede, words.next ?? '', words.details);
  }

  if (status.stage !== 'onboard') {
    return fail('Not taking registrations', 'The machine is running this exam, but it is not taking registrations right now.', `Ask whoever runs Paper Seal to check the machine. ${ask}`, `stage: ${status.stage}`);
  }
  try {
    await withDeadline(tee.registerChallenge(), timeoutMs);
  } catch (error) {
    return fail("Can't take registrations", 'The machine is running this exam, but it could not start a registration.', `Try again in a minute. ${ask}`, message(error));
  }
  return { ok: true };
}
