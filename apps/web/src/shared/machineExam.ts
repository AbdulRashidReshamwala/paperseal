import { decodeToken } from '@paperseal/attestation';
import type { Hex } from '@paperseal/protocol';
import type { TeeClient } from '@paperseal/tee-client';
import { useMemo } from 'react';

import { usePoll } from './usePoll';

/*
 * Which exam the sealed machine was started for. It serves one exam at a time, and `GET /v1/status`
 * does not name it, so a page could otherwise show another exam's stage and registrations as this
 * exam's. This only picks what a page says: it does not verify the token, and `verifyTee` still
 * guards everything that sends or posts.
 */

const POLL_MS = 15_000;
const EXAM_ARG = /^--exam-id=(0x[0-9a-fA-F]{64})$/;

/** The exam in the machine's start arguments, or null if they cannot be read. */
export async function machineExamId(tee: Pick<TeeClient, 'attestation'>): Promise<Hex | null> {
  try {
    const { token } = await tee.attestation();
    const claims = decodeToken(token) as unknown as { submods?: { container?: { args?: unknown } } };
    const args = claims.submods?.container?.args;
    if (!Array.isArray(args)) return null;
    for (const arg of args as unknown[]) {
      const found = typeof arg === 'string' ? EXAM_ARG.exec(arg) : null;
      if (found?.[1]) return found[1].toLowerCase() as Hex;
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether the machine is known to be on another exam. Unknown counts as not elsewhere. */
export function useMachineElsewhere(tee: object | null | undefined, examId: Hex | null): { elsewhere: boolean; settled: boolean } {
  const load = useMemo(() => {
    if (!tee || !examId || !('attestation' in tee)) return null;
    return () => machineExamId(tee as Pick<TeeClient, 'attestation'>);
  }, [tee, examId]);
  const { value, settled } = usePoll(load, POLL_MS);
  return {
    elsewhere: value !== null && examId !== null && value !== examId.toLowerCase(),
    settled: load === null || settled,
  };
}
