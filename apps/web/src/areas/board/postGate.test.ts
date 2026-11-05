import type { TokenVerdict } from '@paperseal/attestation';
import type { Hex } from '@paperseal/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AttestationFailedError } from '../../shared/attest';
import { checkPostTarget } from './postGate';
import { PublishBlockedError } from './publishFlow';

const verifyTee = vi.fn();
vi.mock('../../shared/attest', async (original) => ({
  ...(await original<typeof import('../../shared/attest')>()),
  verifyTee: (...args: unknown[]) => verifyTee(...args) as unknown,
}));

const examId: Hex = `0x${'11'.repeat(32)}`;
const exam = {
  commitHash: `0x${'a'.repeat(40)}`,
  imageDigest: `0x${'b'.repeat(64)}`,
  createdAt: 1n,
  createdBlock: 1n,
  settings: {
    examId,
    examStart: 2_000_000_000n,
    delta: 600n,
    lockRound: 1n,
    unlockRound: 2n,
    endRound: 3n,
    criteriaHash: `0x${'c'.repeat(64)}` as Hex,
    rpcHost: 'rpc.example.org',
  },
};

const registry = (overrides: Record<string, unknown> = {}) =>
  ({
    address: '0x00000000000000000000000000000000000000aa',
    getExam: vi.fn(() => Promise.resolve(exam)),
    getApprovedList: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  }) as never;

const tee = (stage: string) => ({ attestation: vi.fn(), status: vi.fn(() => Promise.resolve({ stage })) }) as never;

const untrusted = { trusted: false, signature: { ok: true }, instanceKey: { ok: true }, claims: [{ claim: 'args', ok: false }] } as unknown as TokenVerdict;

beforeEach(() => {
  verifyTee.mockReset();
  verifyTee.mockResolvedValue({ instancePublicKey: `0x04${'dd'.repeat(64)}`, encryptionPublicKey: '0x04', verdict: {} });
});

describe('checkPostTarget', () => {
  it('passes for the attested TEE at the onboard stage, and names the exam', async () => {
    const target = await checkPostTarget({ tee: tee('onboard'), registry: registry(), examId });
    expect(target).toMatchObject({ examId, stage: 'onboard' });
    expect(target.exam.settings.examId).toBe(examId);
    expect(verifyTee).toHaveBeenCalledOnce();
  });

  it('blocks a TEE whose attestation fails for this exam', async () => {
    verifyTee.mockRejectedValue(new AttestationFailedError(untrusted));
    await expect(checkPostTarget({ tee: tee('onboard'), registry: registry(), examId })).rejects.toThrow(/not the TEE for this exam/);
  });

  it('blocks a TEE that cannot be reached', async () => {
    verifyTee.mockRejectedValue(new TypeError('network down'));
    await expect(checkPostTarget({ tee: tee('onboard'), registry: registry(), examId })).rejects.toBeInstanceOf(PublishBlockedError);
  });

  it.each(['submit', 'lock', 'build', 'released', 'failed'])('blocks the %s stage', async (stage) => {
    await expect(checkPostTarget({ tee: tee(stage), registry: registry(), examId })).rejects.toThrow(`at the ${stage} stage, not onboard`);
  });

  it('blocks a stale pointer to an exam that is not published', async () => {
    const stale = registry({ getExam: vi.fn(() => Promise.resolve(null)) });
    await expect(checkPostTarget({ tee: tee('onboard'), registry: stale, examId })).rejects.toThrow(/stale/);
    // The TEE is not even asked: the exam must exist first.
    expect(verifyTee).not.toHaveBeenCalled();
  });

  it('blocks when a list is already posted', async () => {
    const posted = registry({ getApprovedList: vi.fn(() => Promise.resolve({ listHash: '0x00', postedAt: 1n, postedBlock: 1n })) });
    await expect(checkPostTarget({ tee: tee('onboard'), registry: posted, examId })).rejects.toThrow(/write-once/);
  });
});
