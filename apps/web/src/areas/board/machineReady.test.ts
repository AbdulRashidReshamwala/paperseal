import { describe, expect, it, vi } from 'vitest';

import { checkMachineReady, type ReadyTee } from './machineReady';
import { chainExam, examIdOf, REGISTRY } from './machineTestkit';

const examId = examIdOf(0x11);
const input = { examId, exam: chainExam(examId), registry: REGISTRY, otherExam: () => 'Biology 2026' };
const tee = (status: object | Error, challenge = vi.fn(() => Promise.resolve({ challenge: '0x01' }))) =>
  ({
    status: () => (status instanceof Error ? Promise.reject(status) : Promise.resolve(status)),
    attestation: () => Promise.reject(new Error('down')),
    registerChallenge: challenge,
  }) as unknown as ReadyTee;

describe('checkMachineReady', () => {
  it('says the machine is out of reach when status does not answer', async () => {
    const result = await checkMachineReady(tee(new Error('refused')), input);
    expect(result).toMatchObject({ ok: false, title: "Can't reach the machine", details: 'refused' });
  });

  it('names another exam from the status, without asking for a challenge', async () => {
    const challenge = vi.fn(() => Promise.resolve({ challenge: '0x01' }));
    const result = await checkMachineReady(tee({ stage: 'onboard', examId: examIdOf(0x22) }, challenge), input);
    expect(result).toMatchObject({ ok: false, title: 'Running another exam' });
    expect(challenge).not.toHaveBeenCalled();
  });

  it('does not pass a machine whose attestation cannot be read', async () => {
    const result = await checkMachineReady(tee({ stage: 'onboard', examId }), input);
    expect(result.ok).toBe(false);
  });

  it('is not ready without a machine', async () => {
    expect((await checkMachineReady(null, input)).ok).toBe(false);
  });
});
