import { decodeToken } from '@paperseal/attestation';
import type { Hex } from '@paperseal/protocol';
import type { TeeClient } from '@paperseal/tee-client';
import { useMemo } from 'react';

import { usePoll } from './usePoll';

/*
 * Which exam the sealed machine was started for. It serves one exam at a time, so a page could
 * otherwise show another exam's stage and registrations as this exam's. `GET /v1/status` names it,
 * and a machine on an older image is read from its attestation's start arguments instead. This only
 * picks what a page says: nothing here is verified, and `verifyTee` still guards everything that
 * sends or posts.
 */

const POLL_MS = 15_000;
const EXAM_ARG = /^--exam-id=(0x[0-9a-fA-F]{64})$/;

/** The exam a token's start arguments name, or null if it names none. This reads the token and checks nothing. */
export function examIdInToken(token: string): Hex | null {
  const claims = decodeToken(token) as unknown as { submods?: { container?: { args?: unknown } } };
  const args = claims.submods?.container?.args;
  if (!Array.isArray(args)) return null;
  for (const arg of args as unknown[]) {
    const found = typeof arg === 'string' ? EXAM_ARG.exec(arg) : null;
    if (found?.[1]) return found[1].toLowerCase() as Hex;
  }
  return null;
}

/** The exam the machine says it runs, or null if that cannot be read. */
export async function machineExamId(tee: Partial<Pick<TeeClient, 'status'>> & Pick<TeeClient, 'attestation'>): Promise<Hex | null> {
  try {
    const named = (await tee.status?.())?.examId;
    if (named) return named.toLowerCase() as Hex;
    const { token } = await tee.attestation();
    return examIdInToken(token);
  } catch {
    return null;
  }
}

/** Whether the machine is known to be on another exam. Unknown counts as not elsewhere. */
export function useMachineElsewhere(tee: object | null | undefined, examId: Hex | null): { elsewhere: boolean; settled: boolean } {
  const load = useMemo(() => {
    if (!tee || !examId || !('attestation' in tee)) return null;
    return () => machineExamId(tee as Parameters<typeof machineExamId>[0]);
  }, [tee, examId]);
  const { value, settled } = usePoll(load, POLL_MS);
  return {
    elsewhere: value !== null && examId !== null && value !== examId.toLowerCase(),
    settled: load === null || settled,
  };
}
