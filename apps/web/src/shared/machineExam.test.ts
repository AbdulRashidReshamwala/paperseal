import { describe, expect, it } from 'vitest';

import { machineExamId } from './machineExam';

const examId = `0x${'ab'.repeat(32)}`;
const tokenWith = (claims: unknown) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`;
const tee = (token: string) => ({ attestation: () => Promise.resolve({ token }) }) as never;

describe('machineExamId', () => {
  it('reads the exam from the start arguments', async () => {
    const token = tokenWith({ submods: { container: { args: ['/tee', `--exam-id=${examId}`, '--delta=15'] } } });
    expect(await machineExamId(tee(token))).toBe(examId);
  });

  it('is null when the token or the argument cannot be read', async () => {
    expect(await machineExamId(tee('not-a-token'))).toBeNull();
    expect(await machineExamId(tee(tokenWith({ submods: { container: { args: ['/tee'] } } })))).toBeNull();
    expect(await machineExamId({ attestation: () => Promise.reject(new Error('down')) } as never)).toBeNull();
  });
});
